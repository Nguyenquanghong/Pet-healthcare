import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {once} from 'node:events';
import amqp from 'amqplib';
import {context,client,guard,broker} from './q5-trial.mjs';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {recordAppointmentChange} from '../../../services/clinic/dist/readRevision.js';
import {OutboxRelay} from '../../../services/clinic/dist/relay.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {ReadTokens} from '../../../services/clinic/dist/readToken.js';
import {topology,declareTopology,consumeEvents,publishConfirmed,replayEvent} from '../../../packages/messaging/dist/index.js';
import {waitForQueueIdle} from '../test-project.mjs';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)
const c=context(process.env.CQRS_Q5_CONTEXT),db=client(c,3),routes=topology(c.prefix+'.transport'),projector=new AppointmentProjector(db),results=[];
let conn,ch,base,generation;const owned=[];
async function until(check){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Q5_TRANSPORT_TIMEOUT');}
const send=(e,headers={})=>publishConfirmed(ch,routes.exchange,e.eventType,Buffer.from(JSON.stringify(e)),{messageId:e.eventId,headers});
test.before(async()=>{await guard(db,c);await declareTopology(broker,routes);conn=await amqp.connect(broker);ch=await conn.createConfirmChannel();base=(await db.outboxEvent.findFirstOrThrow({where:{envelope:{path:['eventType'],equals:'clinic.appointment-read-changed.v1'}}})).envelope;generation=(await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).activeGenerationId;});
test.after(async()=>{for(const w of owned)await w.close();await ch?.close();await conn?.close();await db.$disconnect();writeFileSync(c.output+'/transport.json',JSON.stringify({run:c.run,results},null,2));});
for(const target of ['retry','dlq'])for(const window of ['before-publish','after-confirm'])test(target+' transport fails '+window+': original retained, valid replay exactly once',async()=>{
 const event={...base,eventId:randomUUID()},options={retryBaseMs:1};let failed;
 if(window==='before-publish')options.beforeRepublish=async()=>{await failed.channel.close();};
 else options.afterRepublishConfirm=()=>{throw new Error('Q5_CRASH_AFTER_REPUBLISH_CONFIRM');};
 failed=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',async()=>{throw new Error('Q5_APPLY_FAULT');},options);owned.push(failed);
 await send(event,{'p2-attempt':target==='dlq'?2:0});await failed.done;await failed.close();
 assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),0);
 const ready=(await ch.checkQueue(routes.clinicRead)).messageCount,dead=(await ch.checkQueue(routes.clinicRead+'.dlq')).messageCount;
 assert.ok(ready>=1);assert.equal(dead,target==='dlq'&&window==='after-confirm'?1:0);
 const worker=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));owned.push(worker);
 try{if(dead)await replayEvent(broker,routes.clinicRead,event.eventId);await until(async()=>await db.inboxEvent.count({where:{consumerName:'clinic-read-v1:'+generation,eventId:event.eventId}})===1);await waitForQueueIdle([routes.clinicRead]);}
 finally{await worker.close();}
 assert.equal((await ch.checkQueue(routes.clinicRead+'.dlq')).messageCount,0);assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),1);results.push({target,window,readyAfterFault:ready,dlqAfterFault:dead,status:'PASS'});
});
test('broker delivery 5,3,4,2 hydrates latest committed version without regression',async()=>{
 const a=await db.appointment.findFirstOrThrow({where:{status:'pending'}}),events=[];
 // Freshness created version1 appointments; four source transactions follow the
 // real source->revision->outbox protocol, without changing HTTP business rules.
 assert.equal((await db.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:a.id}}})).version,1);
 for(let version=2;version<=5;version++){
  await db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;await tx.appointment.update({where:{id:a.id},data:{serviceName:'Q5 ordering '+version}});await recordAppointmentChange(tx,a.id);});
  events.push((await db.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:a.id},AND:{envelope:{path:['aggregateVersion'],equals:version}}}})).envelope);
 }
 const worker=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));owned.push(worker);const seen=[];
 try{for(const version of [5,3,4,2]){const event=events.find(e=>e.aggregateVersion===version);await send(event);await until(async()=>await db.inboxEvent.count({where:{eventId:event.eventId}})===1);const row=await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation,appointmentId:a.id}}});assert.equal(row.sourceVersion,5);assert.equal(row.serviceName,'Q5 ordering 5');seen.push(row.sourceVersion);}
  const relay=new OutboxRelay(db,broker,a.id);while(await relay.once('q5-ordering',routes)){}await waitForQueueIdle([routes.clinicRead]);
 }finally{await worker.close();}
 results.push({order:[5,3,4,2],observedVersions:seen,status:'PASS'});
});

test('authoritative rollback reads without read-model metadata tables and preserves full source hashes',async()=>{
 const a=await db.appointment.findFirstOrThrow({where:{status:'pending'}}),actor={sub:a.ownerId,role:'owner'},secret='q5-rollback-'+randomUUID();
 process.env.CLINIC_READ_MODE='authoritative';process.env.CLINIC_READ_TOKEN_SECRET=secret;
 const revision=await db.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:a.id}}});
 const token=new ReadTokens(secret).issue(actor,{[a.id]:revision.version});
 const source={acceptsService:()=>true,request:async()=>({actor:{...actor,fullName:'Q5 owner'},pets:[{id:a.petId,ownerId:a.ownerId,name:'Q5 pet',directoryVersion:1}],owners:[{id:a.ownerId,fullName:'Q5 owner',directoryVersion:1}]})};
 const server=createApp(db,()=>actor,source).listen(0,'127.0.0.1');await once(server,'listening');
 const sourceTables=['appointments','medical_records','AppointmentReservation','AppointmentBillingTerminal','booking_status_events','RequestDedup','OutboxEvent'];
 async function fingerprints(){const values=[];for(const table of sourceTables){const [row]=await db.$queryRawUnsafe(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(payload,E'\\n' ORDER BY payload),'')) AS hash FROM (SELECT row_to_json(t)::text AS payload FROM "${table}" t) s`);values.push({table,...row});}return values;}
 const renamed=[];let before;
 try{
  before=await fingerprints();
  for(const table of ['AppointmentReadRow','ReadProjectionControl','ReadProjectionGeneration','ClinicReadRevision']){await db.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME TO "Q5Unavailable${table}"`);renamed.push(table);}
  const request=async path=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{headers:{Authorization:'Bearer owner','X-Clinic-Min-Version':token},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);assert.equal(r.headers.get('x-clinic-read-source'),'authoritative');return r.json();};
  const page=await request('/appointments?id='+a.id);assert.equal(page.items[0].id,a.id);assert.equal(page.items[0].serviceName,a.serviceName);assert.equal(page.pagination.total,1);assert.ok(!('internalNote' in page.items[0]));
  const day=a.appointmentDate.toISOString().slice(0,10),calendar=await request('/appointments/calendar?month='+day.slice(0,7));assert.ok(calendar[day]>=1);
  assert.deepEqual(await fingerprints(),before);
 }finally{for(const table of renamed.reverse())await db.$executeRawUnsafe(`ALTER TABLE "Q5Unavailable${table}" RENAME TO "${table}"`);server.closeAllConnections();await new Promise(r=>server.close(r));}
 results.push({name:'rollback-no-read-metadata',sourceFingerprints:before,status:'PASS'});
});
