import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import {createHash,timingSafeEqual} from 'node:crypto';
import { traceHeaders } from '@nipopeto/runtime';
export type PetSnapshot={id:string;ownerId:string;name:string;directoryVersion:number;[key:string]:unknown};
export type OwnerSnapshot={id:string;fullName:string;directoryVersion:number;[key:string]:unknown};
export type DirectorySnapshot={actor:Actor&{fullName:string};pets:PetSnapshot[];owners:OwnerSnapshot[]};
export class CoreDirectory {
  private readonly origin:URL;
  constructor(url:string,private readonly credential:string,private readonly scopes?:{billing:string;bootstrap:string;evidence:string}) {
    this.origin=new URL(url);
    if(!['http:','https:'].includes(this.origin.protocol)||this.origin.pathname!=='/'||this.origin.search||this.origin.hash||this.origin.username||this.origin.password||credential.length<32||credential.length>512)throw new Error('INVALID_DIRECTORY_CONFIGURATION');
  }
  acceptsService(token:unknown,scope:'billing'|'bootstrap'='billing'){const expected=this.scopes?.[scope]??this.credential;return typeof token==='string'&&token.length<=512&&timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(expected).digest());}
  async operationEvidence(operationId:string):Promise<{state:'PREPARING'|'COMMITTED'|'ABORTED';appointmentId:string;invoiceId?:string|null}>{
    try{const res=await fetch(new URL('/internal/billing-operations/'+encodeURIComponent(operationId),this.origin),{headers:{...traceHeaders(),'X-Service-Token':this.scopes?.evidence??this.credential},redirect:'error',signal:AbortSignal.timeout(2000)});if(res.status!==200)throw new Error();const value=await res.json();if(value.operationId!==operationId||!['PREPARING','COMMITTED','ABORTED'].includes(value.state)||typeof value.appointmentId!=='string'||!value.appointmentId||value.appointmentId.length>128||value.state==='COMMITTED'&&(typeof value.invoiceId!=='string'||!value.invoiceId||value.invoiceId.length>128))throw new Error();return value;}catch{throw new BusinessError(503,'Core terminal evidence unavailable. Reservation remains held.');}
  }
  async request(actor:Actor,token:string,ids:{petIds?:string[];ownerIds?:string[];doctorId?:string},lookup=false):Promise<DirectorySnapshot>{
    try{
      const res=await fetch(new URL('/internal/directory/'+(lookup?'lookup':'authorize'),this.origin),{method:'POST',headers:{...traceHeaders(),Authorization:`Bearer ${token}`,'X-Service-Token':this.credential,'Content-Type':'application/json'},body:JSON.stringify(ids),redirect:'error',signal:AbortSignal.timeout(2000)});
      if([403,404,422].includes(res.status))throw new BusinessError(res.status as 403|404|422,res.status===403?'Owner or staff permission required.':res.status===404?'Source not found.':'Invalid source IDs.');
      if(res.status!==200)throw new Error();
      const value=await res.json() as DirectorySnapshot;
      if(value.actor?.sub!==actor.sub||value.actor?.role!==actor.role||typeof value.actor?.fullName!=='string'||!Array.isArray(value.pets)||!Array.isArray(value.owners)||value.pets.length>100||value.owners.length>200||value.pets.some(p=>typeof p.id!=='string'||typeof p.ownerId!=='string'||typeof p.name!=='string'||!Number.isSafeInteger(p.directoryVersion)||p.directoryVersion<1)||value.owners.some(o=>typeof o.id!=='string'||typeof o.fullName!=='string'||!Number.isSafeInteger(o.directoryVersion)||o.directoryVersion<1))throw new Error();
      if((ids.petIds??[]).some(id=>!value.pets.some(p=>p.id===id))||(ids.ownerIds??[]).some(id=>!value.owners.some(o=>o.id===id))||actor.role==='owner'&&(value.pets.some(p=>p.ownerId!==actor.sub)||value.owners.some(o=>o.id!==actor.sub)))throw new Error();
      return value;
    }catch(error){if(error instanceof BusinessError)throw error;throw new BusinessError(503,'Core directory unavailable. Retry the same request key.');}
  }
}
// Request-local authorized snapshots only; no global user cache or projection auth.
export class RequestDirectory {
  constructor(private readonly source:CoreDirectory,readonly actor:Actor,readonly token:string,readonly snapshot:DirectorySnapshot){}
  async pet(id:string){const p=this.snapshot.pets.find(p=>p.id===id);if(!p)throw new BusinessError(404,'Authorized pet not found.');return p;}
  lookup(petIds:string[],ownerIds:string[]){return this.source.request(this.actor,this.token,{petIds:[...new Set(petIds)],ownerIds:[...new Set(ownerIds)]},true);}
}
