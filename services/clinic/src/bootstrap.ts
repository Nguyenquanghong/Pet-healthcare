import type { PrismaClient } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import { todayInVietnam } from './domain/validation.js';
import { appointmentDto,medicalRecordDto } from './lib/serialize.js';
import type { RequestDirectory } from './directory.js';
export async function bootstrap(db:PrismaClient,actor:Actor,directory:RequestDirectory,view:unknown){
  if(view===undefined)view='session';if(view!=='session'&&view!=='dashboard')throw new BusinessError(422,'Invalid bootstrap view.');
  if(view==='session')return{appointments:[],medicalRecords:[],medicalImages:[],pets:[],owners:[],summary:{totals:{appointments:0,medicalRecords:0,medicalImages:0},appointmentStatus:{},todayAppointments:0}};
  const own=actor.role==='owner'?{ownerId:actor.sub}:{},today=new Date(todayInVietnam()+'T00:00:00Z');
  const result=await db.$transaction(async tx=>{
    const counts=await tx.appointment.groupBy({by:['status'],where:own,_count:true});
    const appointments=actor.role==='owner'?await tx.appointment.findMany({where:{...own,status:{in:['pending','confirmed']},appointmentDate:{gte:today}},take:5,orderBy:[{appointmentDate:'asc'},{appointmentTime:'asc'},{id:'asc'}]}):[...new Map([...(await tx.appointment.findMany({where:{appointmentDate:today},take:5,orderBy:[{appointmentTime:'asc'},{id:'asc'}]})),...(await tx.appointment.findMany({where:{status:'pending'},take:3,orderBy:[{createdAt:'desc'},{id:'desc'}]}))].map(r=>[r.id,r])).values()];
    const medicalRecords=await tx.medicalRecord.findMany({where:own,take:actor.role==='owner'?1:4,orderBy:[{visitDate:'desc'},{id:'desc'}]});
    return{appointments,medicalRecords,summary:{totals:{appointments:counts.reduce((n,g)=>n+g._count,0),medicalRecords:await tx.medicalRecord.count({where:own}),medicalImages:await tx.medicalImage.count({where:{...own,deletedAt:null}})},appointmentStatus:Object.fromEntries(counts.map(g=>[g.status,g._count])),todayAppointments:await tx.appointment.count({where:{...own,appointmentDate:today}})}};
  },{isolationLevel:'RepeatableRead'});
  const rows=[...result.appointments,...result.medicalRecords],source=rows.length?await directory.lookup(rows.map(r=>r.petId),rows.map(r=>r.ownerId)):{pets:[],owners:[]};
  return{...source,appointments:result.appointments.map(r=>appointmentDto(r,actor.role==='owner')),medicalRecords:result.medicalRecords.map(r=>medicalRecordDto(r,actor.role==='owner')),medicalImages:[],summary:result.summary};
}
