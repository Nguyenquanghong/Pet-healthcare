import { Prisma, type PrismaClient, type AppointmentStatus } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import { calendarDate } from './domain/validation.js';
import { appointmentDto, medicalRecordDto } from './lib/serialize.js';
import type { RequestDirectory } from './directory.js';

export type Resource='appointments'|'medicalRecords'|'medicalImages';
const spa=['spa_bath','spa_grooming','spa_combo'] as const;
const groups:Record<string,AppointmentStatus[]>={pending:['pending','confirmed','checked_in','in_progress'],completed:['completed'],cancelled:['cancelled','no_show']};
export function query(resource:Resource,raw:Record<string,unknown>){
  const integer=(name:string,fallback:number,max:number)=>{if(raw[name]===undefined)return fallback;const v=raw[name];if(typeof v!=='string'||!/^[1-9]\d*$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)>max)throw new BusinessError(422,`Invalid ${name}.`);return Number(v);};
  const result:{page:number;pageSize:number;[key:string]:string|number}={page:integer('page',1,1000000),pageSize:integer('pageSize',20,100)};
  const allowed=resource==='appointments'?['ownerId','petId','status','statusGroup','category','date','mode']:resource==='medicalRecords'?['ownerId','petId']:['petId'];
  for(const k of ['q','id',...allowed]){const v=raw[k];if(v===undefined)continue;if(typeof v!=='string'||v.length>(k==='q'?100:128))throw new BusinessError(422,`Invalid ${k}.`);const value=v.trim();if(!value||(value==='all'&&k!=='q'&&k!=='id'))continue;const options=k==='status'?Object.values(groups).flat():k==='statusGroup'?Object.keys(groups):k==='category'?['medical','spa']:k==='mode'?['unbilled']:undefined;if(options&&!options.includes(value))throw new BusinessError(422,`Invalid ${k}.`);if(k==='date')calendarDate(value,'date');result[k]=value;}
  return result;
}
export async function list(db:PrismaClient,resource:Resource,actor:Actor,directory:RequestDirectory,raw:Record<string,unknown>){
  const q=query(resource,raw),ownerId=actor.role==='owner'?actor.sub:q.ownerId as string|undefined;
  // Search projections are predicates, never an authorization source. Scope is
  // applied to local rows before counts/pagination; page relations use Core.
  const result=await db.$transaction(async tx=>{
    const text=(field:string)=>({[field]:{contains:q.q as string,mode:'insensitive' as const}});
    let petMatches:string[]=[],ownerMatches:string[]=[];
    if(q.q){const matches=await tx.directoryProjection.findMany({where:{deletedAt:null,OR:[text('displayName'),text('phone'),text('breed'),text('email'),text('microchipId'),text('id')]},select:{kind:true,id:true}});ownerMatches=matches.filter(m=>m.kind==='owner').map(m=>m.id);petMatches=matches.filter(m=>m.kind==='pet').map(m=>m.id);const owned=await tx.directoryProjection.findMany({where:{kind:'pet',deletedAt:null,ownerId:{in:ownerMatches}},select:{id:true}});petMatches.push(...owned.map(m=>m.id));}
    const identity=q.id?{id:q.id as string}:{},scope={...(ownerId?{ownerId}:{}),...(q.petId?{petId:q.petId as string}:{})},bounds={skip:(q.page-1)*q.pageSize,take:q.pageSize};
    let total=0,counts:Record<string,number>={},appointments:Awaited<ReturnType<typeof tx.appointment.findMany>>=[],records:Awaited<ReturnType<typeof tx.medicalRecord.findMany>>=[],images:Awaited<ReturnType<typeof tx.medicalImage.findMany>>=[];
    const joined=[{petId:{in:petMatches}},{ownerId:{in:ownerMatches}}];
    if(resource==='appointments'){
      const base:Prisma.AppointmentWhereInput={...scope,...identity,...(q.date?{appointmentDate:new Date(`${q.date}T00:00:00Z`)}:{}),...(q.category?{type:q.category==='spa'?{in:[...spa]}:{notIn:[...spa]}}:{}),...(q.mode==='unbilled'?{status:'completed',reservations:{none:{state:{in:['HELD','INVOICED']}}}}:{}),...(q.q?{OR:[...joined,text('serviceName'),text('id')]}:{})};
      const where:Prisma.AppointmentWhereInput={AND:[base,...(q.statusGroup?[{status:{in:groups[q.statusGroup as string]}}]:[]),...(q.status?[{status:q.status as AppointmentStatus}]:[])]};
      counts=Object.fromEntries((await tx.appointment.groupBy({by:['status'],where:base,_count:true})).map(g=>[g.status,g._count]));
      // These groups already cover the exact base predicate in this snapshot.
      // Apply the remaining status filters to obtain total without another COUNT.
      total=Object.entries(counts).reduce((sum,[status,count])=>sum+(
        (!q.status||q.status===status)&&(!q.statusGroup||groups[q.statusGroup as string]!.includes(status as AppointmentStatus))?count:0),0);
      counts.billingHeld=await tx.appointment.count({where:{...base,reservations:{some:{state:'HELD'}}}});
      appointments=await tx.appointment.findMany({where,...bounds,orderBy:actor.role==='owner'?[{status:'asc'},{appointmentDate:'desc'},{appointmentTime:'desc'},{id:'desc'}]:[{status:'asc'},{createdAt:'desc'},{id:'desc'}]});
    }else if(resource==='medicalRecords'){
      const where:Prisma.MedicalRecordWhereInput={...scope,...identity,...(q.q?{OR:[...joined,text('title'),text('doctorName'),text('diagnosis')]}:{})};
      total=await tx.medicalRecord.count({where});records=await tx.medicalRecord.findMany({where,...bounds,orderBy:[{visitDate:'desc'},{id:'desc'}]});appointments=await tx.appointment.findMany({where:{id:{in:records.flatMap(r=>r.appointmentId?[r.appointmentId]:[])},...(ownerId?{ownerId}:{})}});
    }else{
      const where:Prisma.MedicalImageWhereInput={...identity,...(actor.role==='owner'?{ownerId:actor.sub}:{}),...(q.petId?{petId:q.petId as string}:{}),...(q.q?{OR:[text('title'),{petId:{in:petMatches}}]}:{})};
      total=await tx.medicalImage.count({where});images=await tx.medicalImage.findMany({where,...bounds,orderBy:[{createdAt:'desc'},{id:'desc'}]});
    }
    const projection=q.petId?await tx.directoryProjection.findUnique({where:{kind_id:{kind:'pet',id:q.petId as string}},select:{sourceVersion:true,deletedAt:true}}):null;
    return{total,counts,appointments,records,images,projectionVersion:projection&&!projection.deletedAt?projection.sourceVersion:0};
  },{isolationLevel:'RepeatableRead'});
  const rows=[...result.appointments,...result.records,...result.images];
  const source=rows.length?await directory.lookup(rows.map(r=>r.petId),rows.map(r=>r.ownerId)):{pets:[],owners:[]};
  const related={owners:source.owners,pets:source.pets,appointments:result.appointments.map(r=>appointmentDto(r,actor.role==='owner')),medicalRecords:result.records.map(r=>medicalRecordDto(r,actor.role==='owner')),medicalImages:result.images.map(({ownerId,...image})=>image),hotelBookings:[],dailyCareNotes:[],notifications:[],invoices:[]};
  const currentPet=q.petId?source.pets.find(p=>p.id===q.petId)??await directory.pet(q.petId as string):null;
  return{items:related[resource],pagination:{page:q.page,pageSize:q.pageSize,total:result.total,totalPages:Math.ceil(result.total/q.pageSize)},counts:result.counts,related:{...related,[resource]:[]},
    ...(currentPet?{directory:{petId:currentPet.id,sourceVersion:currentPet.directoryVersion,projectionVersion:result.projectionVersion,searchReady:result.projectionVersion>=currentPet.directoryVersion}}:{}),...(q.q?{searchConsistency:'eventual'}:{})};
}
export async function calendar(db:PrismaClient,actor:Actor,month:unknown,category:unknown){
  if(typeof month!=='string'||!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)||category!==undefined&&!['medical','spa'].includes(String(category)))throw new BusinessError(422,'Invalid month or category.');
  const [y,m]=month.split('-').map(Number);
  const rows=await db.appointment.groupBy({by:['appointmentDate'],where:{...(actor.role==='owner'?{ownerId:actor.sub}:{}),...(category?{type:category==='spa'?{in:[...spa]}:{notIn:[...spa]}}:{}),appointmentDate:{gte:new Date(Date.UTC(y!,m!-1,1)),lt:new Date(Date.UTC(y!,m!,1))}},_count:true});
  return Object.fromEntries(rows.map(r=>[r.appointmentDate.toISOString().slice(0,10),r._count]));
}
