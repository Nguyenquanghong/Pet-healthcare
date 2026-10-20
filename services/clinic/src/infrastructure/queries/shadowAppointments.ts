import {createHash} from 'node:crypto';
import type {PrismaClient,Prisma} from '../../generated/client/index.js';
import type {Actor} from '../../domain/auth.js';
import type {AppointmentQueries,AppointmentQueryDirectory,AppointmentCalendarQuery,AppointmentListResult} from '../../application/ports/appointmentQueries.js';
import {AuthoritativeAppointmentQueries} from './authoritativeAppointments.js';
import {ProjectedAppointmentQueries} from './projectedAppointments.js';
import {reconcileProjection} from '../../projectionSnapshot.js';

function canonical(v:unknown):unknown{if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));return v;}
export const responseHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(v))))).digest('hex');
// Use existing implementations inside one RepeatableRead snapshot. Nested
// transaction callbacks share the outer tx; this facade never commits it.
export function snapshotDatabase(tx:Prisma.TransactionClient):PrismaClient{return new Proxy(tx,{get(target,key){if(key==='$transaction')return (work:(db:Prisma.TransactionClient)=>unknown)=>work(tx);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as PrismaClient;}
export type ShadowReport={operation:'list'|'calendar';result:'match'|'lag'|'mismatch'|'unavailable'|'error';authoritativeHash?:string;projectedHash?:string;differences?:number};
export class ShadowAppointmentQueries implements AppointmentQueries{
  private sequence=0;
  private pending:Promise<void>|undefined;
  readonly stats={sampled:0,skipped:0,match:0,lag:0,mismatch:0,unavailable:0,error:0};
  constructor(private readonly authoritative:AppointmentQueries,private readonly db:PrismaClient,private readonly every=20,private readonly report:(value:ShadowReport)=>void=value=>process.stdout.write(JSON.stringify({service:'clinic-shadow',...value})+'\n')){
    if(!Number.isInteger(every)||every<1||every>10000)throw new Error('INVALID_CLINIC_SHADOW_EVERY');
  }
  private schedule(operation:'list'|'calendar',actor:Actor,run:(reader:AppointmentQueries)=>Promise<unknown>){
    if(++this.sequence%this.every!==0||this.pending){this.stats.skipped++;return;}
    this.stats.sampled++;
    this.pending=(async()=>{
      let result:ShadowReport;
      try{result=await this.db.$transaction(async tx=>{
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='200ms'");
        const control=await tx.readProjectionControl.findUnique({where:{projectionName:'appointments'},include:{activeGeneration:true}});
        if(!control?.activeGenerationId||control.activeGeneration?.state!=='ACTIVE'||!control.activeGeneration.verifiedAt||control.activeGeneration.schemaVersion!==1||control.activeGeneration.projectionName!=='appointments')return {operation,result:'unavailable'} as ShadowReport;
        const snapshot=snapshotDatabase(tx);
        const authoritative=await run(new AuthoritativeAppointmentQueries(snapshot));
        const projected=await run(new ProjectedAppointmentQueries(snapshot,control.activeGenerationId));
        const authoritativeHash=responseHash(authoritative),projectedHash=responseHash(projected);
        if(authoritativeHash===projectedHash)return {operation,result:'match',authoritativeHash,projectedHash} as ShadowReport;
        const diff=await reconcileProjection(tx,control.activeGenerationId,actor.role==='owner'?actor.sub:undefined);
        // Equal-version corruption, ahead rows, orphan/tombstone and registry
        // errors remain mismatches even if another row is concurrently lagging.
        const corruption=diff.corrupt+diff.ahead+diff.extra+diff.registry;
        return {operation,result:!corruption&&(diff.missing+diff.lag)>0?'lag':'mismatch',authoritativeHash,projectedHash,differences:Object.values(diff).reduce((a,b)=>a+b,0)} as ShadowReport;
      },{isolationLevel:'RepeatableRead',maxWait:50,timeout:1000});}
      catch{result={operation,result:'error'};}
      this.stats[result.result]++;
      try{this.report(result);}catch{/* Telemetry cannot fail a request. */}
    })().finally(()=>{this.pending=undefined;});
  }
  async list(actor:Actor,directory:AppointmentQueryDirectory,raw:Record<string,unknown>):Promise<AppointmentListResult>{
    const result=await this.authoritative.list(actor,directory,raw);
    if(raw.mode==='unbilled'){this.stats.skipped++;return result;}
    const capturedPet=result.directory?await directory.pet(result.directory.petId):undefined;
    // No extra Core HTTP work or credentials retained by the background sample.
    const captured:AppointmentQueryDirectory={lookup:async(pets,owners)=>{
      if(pets.some(id=>!result.related.pets.some(p=>p.id===id))||owners.some(id=>!result.related.owners.some(o=>o.id===id)))throw new Error('SHADOW_DIRECTORY_NOT_CAPTURED');
      return {actor:{...actor,fullName:''},pets:[...new Set(pets)].map(id=>result.related.pets.find(p=>p.id===id)!),owners:[...new Set(owners)].map(id=>result.related.owners.find(o=>o.id===id)!)};
    },pet:async id=>{const pet=result.related.pets.find(p=>p.id===id)??(capturedPet?.id===id?capturedPet:undefined);if(!pet)throw new Error('SHADOW_DIRECTORY_NOT_CAPTURED');return pet;}};
    this.schedule('list',{...actor},reader=>reader.list(actor,captured,{...raw}));return result;
  }
  async calendar(actor:Actor,query:AppointmentCalendarQuery){const result=await this.authoritative.calendar(actor,query);this.schedule('calendar',{...actor},reader=>reader.calendar(actor,{...query}));return result;}
  async drain(){await this.pending;}
}
