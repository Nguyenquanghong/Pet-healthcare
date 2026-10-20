import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {assertTestProject,waitForQueueIdle} from '../test-project.mjs';
import {createApp} from '../../../services/clinic/dist/app.js';
import {AppointmentBilling} from '../../../services/clinic/dist/runtimeBilling.js';
import {ClinicInbox} from '../../../services/clinic/dist/inbox.js';
import {recordAppointmentChange,initializeAppointmentProjection} from '../../../services/clinic/dist/readRevision.js';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {OutboxRelay} from '../../../services/clinic/dist/relay.js';
import {topology,declareTopology,consumeEvents,publishConfirmed,replayEvent} from '../../../packages/messaging/dist/index.js';
import amqp from 'amqplib';

assertTestProject();
const contextPath=resolve(process.env.CQRS_Q2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8'));
assert.match(c.run,/^[0-9a-f-]{36}$/);assert.equal(c.schema,'cqrs_q2_'+c.run.replaceAll('-',''));assert.equal(c.marker,'cqrs-q2:'+c.run);
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','6');
const db=new PrismaClient({datasourceUrl:url.href}),generation=randomUUID(),otherGeneration=randomUUID();
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',routes=topology('p2.cqrs-q2.'+c.run);
const owner=randomUUID(),other=randomUUID(),admin=randomUUID(),pet=randomUUID();
const day=new Date(Date.now()+2*86400000).toISOString().slice(0,10),actors={owner:{sub:owner,role:'owner'},admin:{sub:admin,role:'admin'}};
let server,base,connection,channel;const results=[],children=[];
const nap=ms=>new Promise(r=>setTimeout(r,ms));
async function until(work,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const v=await work();if(v)return v;await nap(25);}throw new Error('Timeout '+label);}
const mark=name=>results.push({name,status:'PASS'});
const readEvents=id=>db.outboxEvent.findMany({where:{envelope:{path:['eventType'],equals:'clinic.appointment-read-changed.v1'},AND:{envelope:{path:['aggregateId'],equals:id}}},orderBy:{createdAt:'asc'}});
const revision=id=>db.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:id}}});
const projected=id=>db.appointmentReadRow.findUnique({where:{generation_appointmentId:{generation,appointmentId:id}}});
const body=(time,extra={})=>({petId:pet,type:'general_checkup',date:day,time,serviceName:'Synthetic Q2',...extra});
let minute=0;
async function request(path,{method='GET',payload,token='admin',key}={}){
  const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,...(payload?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:response.status===204?null:await response.json()};
}
async function create(extra={},key=randomUUID()){
  const time=String(8+Math.floor(minute/60)).padStart(2,'0')+':'+String(minute++%60).padStart(2,'0');
  const payload=body(time,extra),r=await request('/api/appointments',{method:'POST',payload,token:'owner',key});assert.equal(r.status,201,JSON.stringify(r.body));return {a:r.body.appointment,payload,key};
}
async function change(a,status,extra={}){const r=await request('/api/appointments/'+a.id+'/status',{method:'PATCH',payload:{status,expectedRevision:a.statusRevision,...extra}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.appointment;}
async function readyMedical(){let {a}=await create();a=await change(a,'confirmed');a=await change(a,'checked_in');return a;}
async function complete(){const a=await readyMedical();const payload={petId:pet,appointmentId:a.id,doctorName:'Synthetic doctor',visitDate:day,title:'Q2 medical',diagnosis:'Fixture',treatment:'Fixture',internalNote:'Q2_PRIVATE'};
  const key=randomUUID(),r=await request('/api/medical-records',{method:'POST',payload,key});assert.equal(r.status,201,JSON.stringify(r.body));return {a:await db.appointment.findUniqueOrThrow({where:{id:a.id}}),payload,key,r};}
const billing=new AppointmentBilling(db);
const send=event=>publishConfirmed(channel,routes.exchange,event.eventType,Buffer.from(JSON.stringify(event)),{messageId:event.eventId,contentType:'application/json'});
async function freshConnection(){connection=await amqp.connect(broker,{timeout:5000});connection.on('error',()=>{});channel=await connection.createConfirmChannel();channel.on('error',()=>{});}
async function lockWait(){return until(async()=>{const [r]=await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ClinicReadRevision%' AND pid<>pg_backend_pid()`;return r.n>0;},'registry lock waiter');}
async function rawUpdate(id,serviceName,options={}){return db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;await tx.appointment.update({where:{id},data:{serviceName}});return recordAppointmentChange(tx,id,options);},{timeout:15000});}
const stopChild=async child=>{if(child.exitCode===null&&child.signalCode===null){child.send({type:'shutdown'});await once(child,'exit');}assert.equal(child.exitCode,0);};

test.before(async()=>{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  await freshConnection();await declareTopology(broker,routes);
  const source={acceptsService:()=>true,request:async actor=>({actor:{...actor,fullName:'Synthetic Q2'},pets:[{id:pet,ownerId:owner,name:'Synthetic pet',directoryVersion:1}],owners:[{id:owner,fullName:'Synthetic owner',directoryVersion:1}]})};
  server=createApp(db,token=>{if(!actors[token])throw new Error('invalid');return actors[token];},source).listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
  server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));
  await channel?.close().catch(()=>{});await connection?.close().catch(()=>{});
  writeFileSync(resolve(c.output,'cases.json'),JSON.stringify({run:c.run,schema:c.schema,generation,results,queues:routes,retained:true},null,2));await db.$disconnect();
});

test('initial adoption backfills historical registry under SQL freeze; repeat cannot reset state',async()=>{
  const historical=await db.appointment.create({data:{id:randomUUID(),petId:randomUUID(),ownerId:owner,type:'general_checkup',serviceName:'Historical source',clinicName:'Fixture',appointmentDate:new Date(day),appointmentTime:'00:00'}});
  const initialized=await initializeAppointmentProjection(db,generation);assert.equal(initialized.registered,1);assert.equal((await revision(historical.id)).version,1);
  assert.equal((await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).activeGenerationId,null);
  await assert.rejects(initializeAppointmentProjection(db,randomUUID()),/ALREADY_INITIALIZED/);
  await rawUpdate(historical.id,'Historical changed');assert.equal((await revision(historical.id)).version,2);
  mark('historical-backfill-no-reset');
});
test('HTTP create and dedup replay atomically emit one minimal read event; source DTO unchanged',async()=>{
  const {a,payload,key}=await create();const again=await request('/api/appointments',{method:'POST',payload,key,token:'owner'});assert.equal(again.status,201);assert.equal(again.body.appointment.id,a.id);
  assert.equal((await revision(a.id)).version,1);const events=await readEvents(a.id);assert.equal(events.length,1);
  assert.deepEqual(events[0].envelope.payload,{appointmentId:a.id,sourceVersion:1,deleted:false});
  assert.ok(!JSON.stringify(events).includes('ownerNote'));assert.ok(!('sourceVersion' in a));mark('http-create-dedup');
});
test('lifecycle status/note/reschedule/cancel/undo emit only effective mutations',async()=>{
  let {a}=await create();a=await change(a,'confirmed');let v=(await revision(a.id)).version;
  a=await change(a,'confirmed',{internalNote:'Q2_PRIVATE'});assert.equal((await revision(a.id)).version,v+1);v++;
  a=await change(a,'confirmed',{internalNote:'Q2_PRIVATE'});assert.equal((await revision(a.id)).version,v);
  a=await change(a,'checked_in');v++;
  const undo=await request('/api/appointments/'+a.id+'/undo-status',{method:'POST',payload:{expectedRevision:a.statusRevision,reason:'Q2 undo'}});assert.equal(undo.status,200,JSON.stringify(undo.body));a=undo.body.appointment;v++;
  const move=await request('/api/appointments/'+a.id+'/reschedule',{method:'PATCH',payload:{date:day,time:'23:59',expectedRevision:a.statusRevision,ownerNote:'Q2 owner'}});assert.equal(move.status,200,JSON.stringify(move.body));a=move.body.appointment;v++;
  const cancel=await request('/api/appointments/'+a.id+'/cancel',{method:'PATCH',payload:{expectedRevision:a.statusRevision},token:'owner'});assert.equal(cancel.status,200,JSON.stringify(cancel.body));v++;
  assert.equal((await revision(a.id)).version,v);assert.equal((await readEvents(a.id)).length,v);mark('lifecycle-effective-only');
});
test('medical completion is atomic; completed/no-op and record dedup do not invent read versions',async()=>{
  const {a,payload,key,r}=await complete();assert.equal((await revision(a.id)).version,4);assert.equal(a.status,'completed');
  assert.equal((await request('/api/medical-records',{method:'POST',payload,key})).status,201);
  assert.equal((await request('/api/medical-records',{method:'POST',payload,key:randomUUID()})).status,201);
  assert.equal((await revision(a.id)).version,4);assert.equal((await readEvents(a.id)).length,4);mark('medical-completion-dedup-noop');
});
test('prepare/HTTP reconcile/inbox terminal flags change read revision independently from statusRevision',async()=>{
  const {a}=await complete(),before=a.statusRevision,op=randomUUID();
  await billing.prepare(op,a.id,before,actors.admin);assert.equal((await revision(a.id)).version,5);
  await billing.prepare(op,a.id,before,actors.admin);assert.equal((await revision(a.id)).version,5);
  const aborted={state:'ABORTED',appointmentId:a.id};await billing.reconcile(op,aborted);await billing.reconcile(op,aborted);assert.equal((await revision(a.id)).version,6);
  const op2=randomUUID();await billing.prepare(op2,a.id,before,actors.admin);const event={eventId:randomUUID(),eventType:'billing.invoice-issued.v1',schemaVersion:1,producer:'core',aggregateType:'billing-operation',aggregateId:op2,aggregateVersion:1,occurredAt:new Date().toISOString(),correlationId:randomUUID(),payload:{operationId:op2,appointmentId:a.id,invoiceId:randomUUID()}};
  await new ClinicInbox(db).apply(JSON.stringify(event));await new ClinicInbox(db).apply(JSON.stringify(event));assert.equal((await revision(a.id)).version,8);
  assert.equal((await db.appointment.findUniqueOrThrow({where:{id:a.id}})).statusRevision,before);
  const late=randomUUID(),v=(await revision(a.id)).version;await billing.reconcile(late,aborted);assert.equal((await revision(a.id)).version,v);
  await assert.rejects(billing.prepare(late,a.id,before,actors.admin));
  await new AppointmentProjector(db).apply(JSON.stringify((await readEvents(a.id))[0].envelope));const projectedRow=await projected(a.id);assert.equal(projectedRow.billingHeld,false);assert.equal(projectedRow.billingInvoiced,true);assert.equal(projectedRow.sourceVersion,8);
  mark('billing-independent-revision-terminal-noop');
});
test('faults after revision/outbox and overflow roll back source, revision and outbox together',async()=>{
  const {a}=await create();
  for(const stage of ['after-revision','after-outbox']){
    await assert.rejects(rawUpdate(a.id,'MUST_ROLL_BACK',{onStage:async at=>{if(at===stage)throw new Error('FAULT');}}),/FAULT/);
    assert.equal((await revision(a.id)).version,1);assert.equal((await readEvents(a.id)).length,1);assert.equal((await db.appointment.findUniqueOrThrow({where:{id:a.id}})).serviceName,'Synthetic Q2');
  }
  await db.clinicReadRevision.update({where:{kind_aggregateId:{kind:'appointment',aggregateId:a.id}},data:{version:2147483647}});
  const r=await request('/api/appointments/'+a.id+'/status',{method:'PATCH',payload:{status:'confirmed',expectedRevision:0}});assert.equal(r.status,409);
  assert.equal((await db.appointment.findUniqueOrThrow({where:{id:a.id}})).statusRevision,0);assert.equal((await readEvents(a.id)).length,1);mark('atomic-fault-rollback-overflow');
});

test('real outbox INSERT failure rolls back create, lifecycle, medical completion, prepare and inbox terminal',async()=>{
  const fault='cqrs_fault_'+c.run.replaceAll('-','');
  const install=()=>db.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" ADD CONSTRAINT "${fault}" CHECK (envelope->>'eventType'<>'clinic.appointment-read-changed.v1') NOT VALID`);
  const remove=()=>db.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" DROP CONSTRAINT "${fault}"`);
  const count=await db.appointment.count(),key=randomUUID();await install();
  try{
    const r=await request('/api/appointments',{method:'POST',token:'owner',payload:body('22:00'),key});assert.ok([500,503].includes(r.status));
    assert.equal(await db.appointment.count(),count);assert.equal(await db.requestDedup.count({where:{key}}),0);
  }finally{await remove();}
  const {a}=await create();await install();
  try{
    const r=await request('/api/appointments/'+a.id+'/status',{method:'PATCH',payload:{status:'confirmed',expectedRevision:0}});assert.ok([500,503].includes(r.status));
    assert.equal((await db.appointment.findUniqueOrThrow({where:{id:a.id}})).status,'pending');assert.equal((await revision(a.id)).version,1);
    assert.equal(await db.bookingStatusEvent.count({where:{bookingId:a.id}}),0);
  }finally{await remove();}
  const checked=await readyMedical(),payload={petId:pet,appointmentId:checked.id,doctorName:'Fixture',visitDate:day,title:'Rollback fixture',diagnosis:'Fixture',treatment:'Fixture'};await install();
  try{
    const r=await request('/api/medical-records',{method:'POST',payload,key:randomUUID()});assert.ok([500,503].includes(r.status));
    assert.equal(await db.medicalRecord.count({where:{appointmentId:checked.id}}),0);assert.equal((await revision(checked.id)).version,3);
    assert.equal((await db.appointment.findUniqueOrThrow({where:{id:checked.id}})).status,'checked_in');
  }finally{await remove();}
  const {a:completed}=await complete(),operationId=randomUUID();await install();
  try{
    await assert.rejects(billing.prepare(operationId,completed.id,completed.statusRevision,actors.admin));
    assert.equal(await db.appointmentReservation.count({where:{operationId}}),0);assert.equal((await revision(completed.id)).version,4);
  }finally{await remove();}
  await billing.prepare(operationId,completed.id,completed.statusRevision,actors.admin);
  const event={eventId:randomUUID(),eventType:'billing.invoice-issued.v1',schemaVersion:1,producer:'core',aggregateType:'billing-operation',aggregateId:operationId,aggregateVersion:1,occurredAt:new Date().toISOString(),correlationId:randomUUID(),payload:{operationId,appointmentId:completed.id,invoiceId:randomUUID()}};
  await install();
  try{
    await assert.rejects(new ClinicInbox(db).apply(JSON.stringify(event)));
    assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),0);assert.equal(await db.appointmentBillingTerminal.count({where:{operationId}}),0);
    assert.equal((await db.appointmentReservation.findUniqueOrThrow({where:{operationId}})).state,'HELD');assert.equal((await revision(completed.id)).version,5);
    await assert.rejects(billing.reconcile(operationId,{state:'COMMITTED',appointmentId:completed.id,invoiceId:event.payload.invoiceId}));
    assert.equal((await db.appointmentReservation.findUniqueOrThrow({where:{operationId}})).state,'HELD');assert.equal((await revision(completed.id)).version,5);
  }finally{await remove();}
  await new ClinicInbox(db).apply(JSON.stringify(event));assert.equal((await revision(completed.id)).version,6);mark('each-writer-real-outbox-failure-atomicity');
});
test('old/reversed/duplicate messages and two projectors hydrate latest source into every target generation',async()=>{
  const {a}=await create();await rawUpdate(a.id,'Version 2');await rawUpdate(a.id,'Version 3');const events=await readEvents(a.id);
  const p1=new AppointmentProjector(db),p2=new AppointmentProjector(db);await p1.apply(JSON.stringify(events[0].envelope));
  assert.equal((await projected(a.id)).sourceVersion,3);assert.equal((await projected(a.id)).serviceName,'Version 3');
  await Promise.all([...Array(10)].map((_,i)=>(i%2?p1:p2).apply(JSON.stringify(events[i%events.length].envelope))));
  assert.equal((await projected(a.id)).sourceVersion,3);assert.ok(p1.stats.duplicates+p2.stats.duplicates>0);
  await db.readProjectionGeneration.create({data:{id:otherGeneration,state:'BUILDING'}});
  assert.equal(await p1.apply(JSON.stringify(events[0].envelope)),true);
  assert.equal((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation:otherGeneration,appointmentId:a.id}}})).sourceVersion,3);
  assert.equal(await db.inboxEvent.count({where:{eventId:events[0].id}}),2);
  await db.readProjectionGeneration.update({where:{id:otherGeneration},data:{state:'RETIRED'}});mark('latest-hydrate-reverse-duplicate-generations');
});
test('projector rollback cannot leave successful inbox or partial read row; future/missing revisions fail closed',async()=>{
  const {a}=await create(),event=(await readEvents(a.id))[0].envelope;
  await assert.rejects(new AppointmentProjector(db,async stage=>{if(stage==='row-written')throw new Error('PROJECTOR_FAULT');}).apply(JSON.stringify(event)),/PROJECTOR_FAULT/);
  assert.equal(await projected(a.id),null);assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),0);
  const future={...event,eventId:randomUUID(),aggregateVersion:9,payload:{...event.payload,sourceVersion:9}};
  await assert.rejects(new AppointmentProjector(db).apply(JSON.stringify(future)),/VERSION_UNAVAILABLE/);
  assert.equal(await db.inboxEvent.count({where:{eventId:future.eventId}}),0);
  const missing=randomUUID(),absent={...event,eventId:randomUUID(),aggregateId:missing,payload:{...event.payload,appointmentId:missing}};
  await assert.rejects(new AppointmentProjector(db).apply(JSON.stringify(absent)),/VERSION_UNAVAILABLE/);
  assert.equal(await db.inboxEvent.count({where:{eventId:absent.eventId}}),0);mark('projector-rollback-future-version');
});
test('registry tombstone survives source deletion and stale upsert messages cannot resurrect row',async()=>{
  const {a}=await create(),old=(await readEvents(a.id))[0].envelope;await new AppointmentProjector(db).apply(JSON.stringify(old));
  await db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;await tx.appointment.delete({where:{id:a.id}});await recordAppointmentChange(tx,a.id,{deleted:true});});
  const deletion=(await readEvents(a.id)).find(e=>e.envelope.payload.deleted).envelope;
  await new AppointmentProjector(db).apply(JSON.stringify(deletion));await new AppointmentProjector(db).apply(JSON.stringify({...old,eventId:randomUUID()}));
  assert.equal(await projected(a.id),null);assert.equal((await revision(a.id)).deleted,true);assert.equal((await revision(a.id)).version,2);mark('tombstone-no-resurrection');
});
test('projector/writer lock races never stamp new data with an old version and avoid reverse source locks', {timeout:45000},async()=>{
  const {a}=await create(),event=(await readEvents(a.id))[0].envelope;
  const locked=Promise.withResolvers(),release=Promise.withResolvers();
  const applying=new AppointmentProjector(db,async stage=>{if(stage==='registry-locked'){locked.resolve();await release.promise;}}).apply(JSON.stringify(event));await locked.promise;
  const writing=rawUpdate(a.id,'Concurrent v2');await lockWait();release.resolve();await applying;await writing;
  assert.equal((await projected(a.id)).sourceVersion,1);assert.equal((await projected(a.id)).serviceName,'Synthetic Q2');
  const latest=(await readEvents(a.id)).find(e=>e.envelope.aggregateVersion===2).envelope;await new AppointmentProjector(db).apply(JSON.stringify(latest));assert.equal((await projected(a.id)).serviceName,'Concurrent v2');
  const held=Promise.withResolvers(),commit=Promise.withResolvers();
  const writer=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;await tx.appointment.update({where:{id:a.id},data:{serviceName:'Delayed v3'}});await recordAppointmentChange(tx,a.id);held.resolve();await commit.promise;},{timeout:20000});await held.promise;
  const reader=new AppointmentProjector(db).apply(JSON.stringify({...event,eventId:randomUUID()}));await lockWait();commit.resolve();await writer;await reader;
  assert.equal((await projected(a.id)).sourceVersion,3);assert.equal((await projected(a.id)).serviceName,'Delayed v3');mark('mvcc-writer-projector-races');
});

test('Rabbit routing isolates read events; two consumers ACK duplicates only after committed SQL', {timeout:30000},async()=>{
  const {a}=await create(),event=(await readEvents(a.id))[0].envelope;
  await send(event);await send(event);
  assert.equal((await channel.checkQueue(routes.clinic)).messageCount,0);assert.equal((await channel.checkQueue(routes.notification)).messageCount,0);
  const p1=new AppointmentProjector(db),p2=new AppointmentProjector(db);
  const workers=await Promise.all([p1,p2].map(p=>consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>p.apply(raw))));
  try{await until(()=>projected(a.id),'projected broker delivery');await waitForQueueIdle([routes.clinicRead]);}
  finally{await Promise.all(workers.map(w=>w.close()));}
  assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),1);assert.equal(p1.stats.applied+p2.stats.applied,1);assert.equal(p1.stats.duplicates+p2.stats.duplicates,1);
  mark('broker-routing-two-consumers-duplicate-ack');
});

test('real process kill before commit rolls back; kill after commit before ACK redelivers without duplicate effect', {timeout:60000},async()=>{
  for(const mode of ['before-commit','after-commit']){
    const {a}=await create(),event=(await readEvents(a.id))[0].envelope;
    const child=spawn(process.execPath,['tools/phase2/cqrs/projector-child.mjs',mode],{env:{...process.env,CQRS_Q2_CONTEXT:contextPath},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
    const stages=new Set();let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);child.on('message',m=>{if(m?.stage)stages.add(m.stage);});
    await until(()=>{if(child.exitCode!==null)throw new Error('Fault worker exited before ready');return stages.has('ready');},'fault worker ready');
    await send(event);await until(()=>stages.has(mode),'fault barrier '+mode);
    const gone=once(child,'exit');child.kill('SIGKILL');await gone;
    if(mode==='before-commit'){assert.equal(await projected(a.id),null);assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),0);}
    else{assert.equal((await projected(a.id)).sourceVersion,1);assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),1);}
    const projector=new AppointmentProjector(db),worker=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));
    try{await until(()=>projected(a.id),'kill redelivery');await waitForQueueIdle([routes.clinicRead]);}finally{await worker.close();}
    assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),1);assert.equal((await projected(a.id)).sourceVersion,1);
    if(mode==='after-commit')assert.ok(projector.stats.duplicates>=1);
    assert.ok(!/postgresql:|amqp:\/\/|fixture_only|Q2_PRIVATE/.test(logs));
    mark('process-kill-'+mode);
  }
});

test('poison goes to isolated DLQ and a valid faulted event replays with unchanged ID after repair', {timeout:40000},async()=>{
  const {a}=await create(),event=(await readEvents(a.id))[0].envelope;
  let failing=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',async()=>{throw new Error('SIMULATED_DB_OUTAGE');},{retryBaseMs:10});
  try{await send(event);await until(async()=>(await channel.checkQueue(routes.clinicRead+'.dlq')).messageCount===1,'valid event DLQ');}finally{await failing.close();}
  assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),0);
  const replayed=await replayEvent(broker,routes.clinicRead,event.eventId);assert.equal(replayed.eventId,event.eventId);
  const repaired=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>new AppointmentProjector(db).apply(raw));
  try{await until(()=>projected(a.id),'replay after repair');await waitForQueueIdle([routes.clinicRead]);}finally{await repaired.close();}
  assert.equal(await db.inboxEvent.count({where:{eventId:event.eventId}}),1);
  const isolated=topology('p2.cqrs-q2.'+c.run+'.poison');await declareTopology(broker,isolated);
  const poison={...event,eventId:randomUUID(),payload:{...event.payload,internalNote:'FORBIDDEN'}};
  const rejector=await consumeEvents(broker,isolated.clinicRead,'clinic-read-v1',async()=>{assert.fail('Parser must reject poison before apply');});
  try{
    await publishConfirmed(channel,isolated.exchange,poison.eventType,Buffer.from(JSON.stringify(poison)),{messageId:poison.eventId});
    await until(async()=>(await channel.checkQueue(isolated.clinicRead+'.dlq')).messageCount===1,'poison DLQ');
  }finally{await rejector.close();}
  assert.equal(await db.inboxEvent.count({where:{eventId:poison.eventId}}),0);mark('valid-dlq-replay-and-poison-isolation');
});

test('relay confirm-before-mark crash republishes safely with original eventId', {timeout:30000},async()=>{
  const {a}=await create(),event=(await readEvents(a.id))[0];const relay=new OutboxRelay(db,broker,a.id);
  await assert.rejects(relay.once(randomUUID(),routes,()=>{throw new Error('CRASH_AFTER_CONFIRM');}),/CRASH_AFTER_CONFIRM/);
  assert.equal((await db.outboxEvent.findUniqueOrThrow({where:{id:event.id}})).publishedAt,null);
  await db.outboxEvent.update({where:{id:event.id},data:{leaseUntil:new Date(Date.now()-1000)}});
  assert.equal(await relay.once(randomUUID(),routes),true);
  const projector=new AppointmentProjector(db),worker=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));
  try{await until(()=>projected(a.id),'relay crash replay');await waitForQueueIdle([routes.clinicRead]);}finally{await worker.close();}
  assert.equal(await db.inboxEvent.count({where:{eventId:event.id}}),1);assert.ok(projector.stats.duplicates>=1);
  assert.ok((await db.outboxEvent.findUniqueOrThrow({where:{id:event.id}})).publishedAt);mark('relay-confirm-crash-redelivery');
});

test('two built read workers recover durable queue and outbox after real trial broker restart; graceful shutdown drains', {timeout:120000},async()=>{
  const owned=[];let brokerStopped=false;
  const docker=(...args)=>execFileSync('docker',['compose','-p','pet-phase2-p1-test','-f','deploy/phase2/compose.test.yml',...args],{stdio:'pipe',timeout:45000});
  async function worker(){
    const child=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...process.env,DATABASE_URL:url.href,BROKER_URL:broker,BROKER_PREFIX:'p2.cqrs-q2.'+c.run,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1'},stdio:['ignore','pipe','pipe','ipc']});children.push(child);owned.push(child);
    let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);child.q2logs=()=>logs;
    await until(()=>{if(child.exitCode!==null)throw new Error('Built read worker failed');return logs.includes('worker-ready');},'built projector ready');return child;
  }
  try{
    await worker();await worker();const {a}=await create(),event=(await readEvents(a.id))[0].envelope;await send(event);
    await until(()=>projected(a.id),'built worker initial');await waitForQueueIdle([routes.clinicRead]);
    // Prove durable backlog, rather than merely testing a clean reconnect.
    await Promise.all(owned.map(stopChild));
    const queued=await create(),queuedEvent=(await readEvents(queued.a.id))[0].envelope;await send(queuedEvent);
    assert.equal((await channel.checkQueue(routes.clinicRead)).messageCount,1);
    owned.length=0;await channel.close();await connection.close();channel=undefined;connection=undefined;
    assertTestProject();assert.equal(docker('exec','-T','rabbitmq','hostname').toString().trim(),'p2-rabbit-test');
    docker('stop','rabbitmq');brokerStopped=true;
    const pending=await create();const relay=new OutboxRelay(db,broker,pending.a.id);await assert.rejects(relay.once(randomUUID(),routes));
    const outbox=(await readEvents(pending.a.id))[0];const row=await db.outboxEvent.findUniqueOrThrow({where:{id:outbox.id}});assert.equal(row.publishedAt,null);assert.equal(row.lastErrorCode,'DELIVERY_UNCONFIRMED');
    // Workers started while the broker is down must reconnect, not exit with data loss.
    for(let i=0;i<2;i++){
      const child=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...process.env,DATABASE_URL:url.href,BROKER_URL:broker,BROKER_PREFIX:'p2.cqrs-q2.'+c.run,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1'},stdio:['ignore','pipe','pipe','ipc']});children.push(child);owned.push(child);let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);child.q2logs=()=>logs;
    }
    await until(()=>owned.every(p=>p.q2logs().includes('WORKER_RETRY')),'dependency reconnect');
    docker('up','-d','--wait','--no-build','--pull','never','rabbitmq');brokerStopped=false;
    await freshConnection();await until(()=>owned.every(p=>p.q2logs().includes('worker-ready')),'restart ready',30000);
    await until(()=>projected(queued.a.id),'durable queue survives restart',30000);
    await until(()=>relay.once(randomUUID(),routes),'retained outbox republishes',30000);
    await until(()=>projected(pending.a.id),'outbox recovery',30000);await waitForQueueIdle([routes.clinicRead]);
    assert.ok((await db.outboxEvent.findUniqueOrThrow({where:{id:outbox.id}})).publishedAt);
    assert.ok(owned.every(p=>!p.q2logs().match(/fixture_only|postgresql:|amqp:\/\/|Q2_PRIVATE/)));
    mark('built-workers-broker-restart-durable-outbox');
  }finally{
    if(brokerStopped)docker('up','-d','--wait','--no-build','--pull','never','rabbitmq');
    if(!connection)await freshConnection();
    await Promise.all(owned.map(stopChild));
  }
});
