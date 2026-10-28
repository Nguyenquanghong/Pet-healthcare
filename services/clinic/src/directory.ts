import type { Response } from 'express';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import {createHash,timingSafeEqual} from 'node:crypto';
import { traceHeaders, CircuitBreaker, integer } from '@nipopeto/runtime';
import type { PetSnapshot, OwnerSnapshot, DirectorySnapshot, DirectoryLookup } from './application/ports/directory.js';
import type { AppointmentQueryDirectory } from './application/ports/appointmentQueries.js';
export type { PetSnapshot, OwnerSnapshot, DirectorySnapshot } from './application/ports/directory.js';
// Core answered (a business refusal); the dependency is healthy for the breaker.
class CoreResponded extends Error {}
const coreFailure=(error:unknown)=>!(error instanceof BusinessError)&&!(error instanceof CoreResponded);
export class CoreDirectory {
  private readonly origin:URL;
  // Every Clinic request needs Core; when Core hangs, fail at once instead of
  // holding each request for its 2 s timeout (one breaker per process).
  readonly breaker=new CircuitBreaker('core-directory',integer('CORE_DIRECTORY_BREAKER_FAILURES',5,1,100),integer('CORE_DIRECTORY_BREAKER_OPEN_MS',5000,100,60000));
  constructor(url:string,private readonly credential:string,private readonly scopes?:{billing:string;bootstrap:string;evidence:string}) {
    this.origin=new URL(url);
    if(!['http:','https:'].includes(this.origin.protocol)||this.origin.pathname!=='/'||this.origin.search||this.origin.hash||this.origin.username||this.origin.password||credential.length<32||credential.length>512)throw new Error('INVALID_DIRECTORY_CONFIGURATION');
  }
  acceptsService(token:unknown,scope:'billing'|'bootstrap'='billing'){const expected=this.scopes?.[scope]??this.credential;return typeof token==='string'&&token.length<=512&&timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(expected).digest());}
  async operationEvidence(operationId:string):Promise<{state:'PREPARING'|'COMMITTED'|'ABORTED';appointmentId:string;invoiceId?:string|null}>{
    try{return await this.breaker.run(async()=>{const res=await fetch(new URL('/internal/billing-operations/'+encodeURIComponent(operationId),this.origin),{headers:{...traceHeaders(),'X-Service-Token':this.scopes?.evidence??this.credential},redirect:'error',signal:AbortSignal.timeout(2000)});if(res.status!==200)throw res.status>=500?new Error():new CoreResponded();const value=await res.json();if(value.operationId!==operationId||!['PREPARING','COMMITTED','ABORTED'].includes(value.state)||typeof value.appointmentId!=='string'||!value.appointmentId||value.appointmentId.length>128||value.state==='COMMITTED'&&(typeof value.invoiceId!=='string'||!value.invoiceId||value.invoiceId.length>128))throw new Error();return value;},coreFailure);}catch{throw new BusinessError(503,'Core terminal evidence unavailable. Reservation remains held.');}
  }
  async request(actor:Actor,token:string,ids:{petIds?:string[];ownerIds?:string[];doctorId?:string},lookup=false):Promise<DirectorySnapshot>{
    try{return await this.breaker.run(async()=>{
      const res=await fetch(new URL('/internal/directory/'+(lookup?'lookup':'authorize'),this.origin),{method:'POST',headers:{...traceHeaders(),Authorization:`Bearer ${token}`,'X-Service-Token':this.credential,'Content-Type':'application/json'},body:JSON.stringify(ids),redirect:'error',signal:AbortSignal.timeout(2000)});
      // AQ-05: only an explicit revocation becomes a client 401; any other 401 is
      // a service-credential/config failure and keeps failing closed below.
      if(res.status===401&&(await res.clone().json().catch(()=>null) as {code?:unknown}|null)?.code==='SESSION_REVOKED')throw new BusinessError(401,'Your password was changed. Sign in again.');
      if([403,404,422].includes(res.status))throw new BusinessError(res.status as 403|404|422,res.status===403?'Owner or staff permission required.':res.status===404?'Source not found.':'Invalid source IDs.');
      if(res.status!==200)throw new Error();
      const value=await res.json() as DirectorySnapshot;
      if(value.actor?.sub!==actor.sub||value.actor?.role!==actor.role||typeof value.actor?.fullName!=='string'||!Array.isArray(value.pets)||!Array.isArray(value.owners)||value.pets.length>100||value.owners.length>200||value.pets.some(p=>typeof p.id!=='string'||typeof p.ownerId!=='string'||typeof p.name!=='string'||!Number.isSafeInteger(p.directoryVersion)||p.directoryVersion<1)||value.owners.some(o=>typeof o.id!=='string'||typeof o.fullName!=='string'||!Number.isSafeInteger(o.directoryVersion)||o.directoryVersion<1))throw new Error();
      if((ids.petIds??[]).some(id=>!value.pets.some(p=>p.id===id))||(ids.ownerIds??[]).some(id=>!value.owners.some(o=>o.id===id))||actor.role==='owner'&&(value.pets.some(p=>p.ownerId!==actor.sub)||value.owners.some(o=>o.id!==actor.sub)))throw new Error();
      if(ids.doctorId&&(value.doctor?.id!==ids.doctorId||typeof value.doctor.fullName!=='string'))throw new Error();
      return value;
    },coreFailure);}catch(error){if(error instanceof BusinessError)throw error;throw new BusinessError(503,'Core directory unavailable. Retry the same request key.');}
  }
}
// Request-local authorized snapshots only; no global user cache or projection auth.
export class RequestDirectory implements DirectoryLookup {
  private readonly pets=new Map<string,PetSnapshot>();
  private readonly owners=new Map<string,OwnerSnapshot>();
  constructor(private readonly source:CoreDirectory,readonly actor:Actor,readonly token:string,readonly snapshot:DirectorySnapshot){
    for(const pet of snapshot.pets)this.pets.set(pet.id,pet);
    for(const owner of snapshot.owners)this.owners.set(owner.id,owner);
  }
  async pet(id:string){const p=this.snapshot.pets.find(p=>p.id===id);if(!p)throw new BusinessError(404,'Authorized pet not found.');return p;}
  signer(){const {sub,fullName}=this.snapshot.actor;return{id:sub,fullName};}
  // The snapshot already covers a doctorId named in the request body. Any other
  // doctor (an appointment's) is checked with Core on demand.
  async doctor(id:string){
    const {doctor}=this.snapshot;
    if(doctor?.id===id)return doctor;
    return (await this.source.request(this.actor,this.token,{doctorId:id},true)).doctor!;
  }
  async lookup(petIds:string[],ownerIds:string[]):Promise<DirectorySnapshot>{
    const wantedPets=[...new Set(petIds)],wantedOwners=[...new Set(ownerIds)];
    if(wantedPets.length>100||wantedOwners.length>100)throw new BusinessError(422,'Invalid directory IDs.');
    const missingPets=wantedPets.filter(id=>!this.pets.has(id)),missingOwners=wantedOwners.filter(id=>!this.owners.has(id));
    if(missingPets.length||missingOwners.length){
      const value=await this.source.request(this.actor,this.token,{petIds:missingPets,ownerIds:missingOwners},true);
      for(const pet of value.pets)this.pets.set(pet.id,pet);
      for(const owner of value.owners)this.owners.set(owner.id,owner);
    }
    const pets=wantedPets.map(id=>this.pets.get(id)!);
    const owners=[...new Set([...wantedOwners,...pets.map(p=>p.ownerId)])].map(id=>this.owners.get(id)!);
    return{actor:this.snapshot.actor,pets,owners};
  }
}
// Deferred authorization for list GETs: the query runs first, then Core is asked once for the
// initial pet plus the page's pets and owners (one memoized authorize). Core's answer still
// outranks everything: authorizedRead (app.ts) calls settle() before it sends or rethrows.
export class DeferredDirectory implements AppointmentQueryDirectory {
  private opened?:Promise<RequestDirectory>;
  private answered=false;
  constructor(private readonly source:CoreDirectory,readonly actor:Actor,readonly token:string,private readonly initialPetIds:string[]){}
  // True once Core authorized this request; a response may only be sent after that.
  get settled(){return this.answered;}
  private open(petIds:string[]=[],ownerIds:string[]=[]){
    return this.opened??=this.source.request(this.actor,this.token,{petIds:[...new Set([...this.initialPetIds,...petIds])],ownerIds:[...new Set(ownerIds)]}).then(snapshot=>{this.answered=true;return new RequestDirectory(this.source,this.actor,this.token,snapshot);});
  }
  async pet(id:string){return (await this.open()).pet(id);}
  async lookup(petIds:string[],ownerIds:string[]):Promise<DirectorySnapshot>{
    // Over Core's 100-id limit: authorize the initial pet alone, then let lookup fetch the rest.
    const fits=new Set([...this.initialPetIds,...petIds]).size<=100&&new Set(ownerIds).size<=100;
    return (await (fits?this.open(petIds,ownerIds):this.open())).lookup(petIds,ownerIds);
  }
  async settle(){await this.open();}
}
// Fail closed: a deferred route never sends a 2xx before Core authorized the request. If a handler
// skips authorizedRead, its answer becomes a 503.
export function failClosed(res:Response,directory:{readonly settled:boolean}){
  const send=res.send.bind(res);
  res.send=((body?:unknown)=>{
    if(res.statusCode<300&&!directory.settled){res.status(503).setHeader('Retry-After','1');res.type('json');return send(JSON.stringify({error:'Core directory unavailable. Retry the same request key.'}));}
    return send(body);
  }) as typeof res.send;
}
