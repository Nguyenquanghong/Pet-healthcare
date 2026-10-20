import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {recordAppointmentChange} from '../../../services/clinic/dist/readRevision.js';
import {AppointmentAggregateCache} from '../../../services/clinic/dist/infrastructure/queries/appointmentAggregateCache.js';
import {ProjectedAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';
import {snapshotDatabase} from '../../../services/clinic/dist/infrastructure/queries/shadowAppointments.js';
import {reconcileProjection} from '../../../services/clinic/dist/projectionSnapshot.js';

export async function verifyAggregateWrites(db,url,context,output){
 await guard(db,url,context);assert.equal(await db.appointment.count(),100000);
 const api=new PrismaClient({datasourceUrl:url.href}),cache=new AppointmentAggregateCache(),projector=new AppointmentProjector(db);
 const generation=(await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).activeGenerationId;
 const base=await db.appointment.findFirstOrThrow(),id=randomUUID(),actor={role:'owner',sub:base.ownerId},row={...base,id,appointmentDate:new Date('2080-04-01'),status:'pending'};
 const report={status:'STARTING',cases:[]},epochs=()=>db.$queryRaw`SELECT scope,revision::text AS revision FROM "AppointmentQueryEpoch" ORDER BY scope`;
 const calendar=()=>api.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return new ProjectedAppointmentQueries(snapshotDatabase(tx),generation,undefined,cache).calendar(actor,{month:'2080-04'});},{isolationLevel:'RepeatableRead'});
 const event=async work=>db.$transaction(async tx=>{const change=await work(tx);return (await tx.outboxEvent.findUniqueOrThrow({where:{id:change.eventId}})).envelope;});
 try{
  const before=await epochs();await assert.rejects(event(async tx=>{await tx.appointment.create({data:row});return recordAppointmentChange(tx,id,{created:true,onStage:async stage=>{if(stage==='after-outbox')throw new Error('WRITER_ROLLBACK');}});}),/WRITER_ROLLBACK/);
  assert.deepEqual(await epochs(),before);assert.equal(await db.appointment.count({where:{id}}),0);report.cases.push('writer create failure rolls back source epoch, registry and outbox');
  assert.deepEqual(await calendar(),{});assert.deepEqual(await calendar(),{});
  const created=await event(async tx=>{await tx.appointment.create({data:row});return recordAppointmentChange(tx,id,{created:true});});
  assert.deepEqual(await calendar(),{});await projector.apply(JSON.stringify(created));assert.deepEqual(await calendar(),{'2080-04-01':1});
  const applied=await epochs();await projector.apply(JSON.stringify(created));assert.deepEqual(await epochs(),applied);report.cases.push('real outbox/projector invalidates cache on apply; replay does not change epoch');
  const moved=await event(async tx=>{await tx.appointment.update({where:{id},data:{appointmentDate:new Date('2080-04-02')}});return recordAppointmentChange(tx,id);});
  const preFault=await epochs(),failing=new AppointmentProjector(db,async stage=>{if(stage==='row-written')throw new Error('PROJECTOR_ROLLBACK');});
  await assert.rejects(failing.apply(JSON.stringify(moved)),/PROJECTOR_ROLLBACK/);assert.deepEqual(await epochs(),preFault);assert.deepEqual(await calendar(),{'2080-04-01':1});
  await projector.apply(JSON.stringify(moved));assert.deepEqual(await calendar(),{'2080-04-02':1});report.cases.push('projector row/inbox/epoch failure rolls back atomically and replay publishes new date');
  const deleted=await event(async tx=>{await tx.appointment.delete({where:{id}});return recordAppointmentChange(tx,id,{deleted:true});});
  assert.deepEqual(await calendar(),{});await projector.apply(JSON.stringify(deleted));assert.deepEqual(await calendar(),{});report.cases.push('source delete invalidates cached count before tombstone delivery');
  // TRUNCATE must also invalidate; rollback restores data and every guard row.
  const preTruncate=await epochs();await assert.rejects(db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('TRUNCATE "DirectoryProjection", "AppointmentReadRow"');
   const changed=await tx.$queryRaw`SELECT scope,revision::text AS revision FROM "AppointmentQueryEpoch" ORDER BY scope`;
   assert.notDeepEqual(changed,preTruncate);throw new Error('TRUNCATE_ROLLBACK');
  }),/TRUNCATE_ROLLBACK/);assert.deepEqual(await epochs(),preTruncate);assert.equal(await db.appointmentReadRow.count({where:{generation}}),100000);report.cases.push('TRUNCATE triggers participate in transaction rollback');
  const diff=await db.$transaction(tx=>reconcileProjection(tx,generation),{timeout:15000});assert.ok(Object.values(diff).every(n=>n===0));report.diff=diff;
  assert.equal(await db.appointment.count(),100000);report.status='PASS';return report;
 }catch(error){report.status='FAIL';report.errorType=error.name;report.errorCode=error.code;throw error;}
 finally{await api.$disconnect();writeFileSync(resolve(output,'aggregate-writes.json'),JSON.stringify(report,null,2));}
}
