// D5 local functional fault/recovery on real PostgreSQL + RabbitMQ with the BUILT
// V2 read worker and the real Clinic outbox relay. Local dev-host timings are
// functional evidence only; acceptance timing belongs to the frozen Kaggle profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import amqp from 'amqplib';
import {assertTestProject} from '../../test-project.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {recordAppointmentChange,initializeAppointmentProjection} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentRebuild} from '../../../../services/clinic/dist/readRebuild.js';
import {OutboxRelay} from '../../../../services/clinic/dist/relay.js';
import {reconcileProjection} from '../../../../services/clinic/dist/projectionSnapshot.js';
import {summaryDrift} from '../../../../services/clinic/dist/clinicActivitySummary.js';
import {ReadFreshness,probeReadQueue} from '../../../../services/clinic/dist/readFreshness.js';
import {ActivitySummaryEvidence,AuditLane} from '../../../../services/clinic/dist/activitySummaryEvidence.js';
import {ClinicActivityQueries} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';
import {parseActivityFilter} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {topology,declareTopology,publishConfirmed,replayEvent} from '../../../../packages/messaging/dist/index.js';
import {buildActivityFixture} from './fixture.mjs';
import {nearestRank} from './bench/generator.mjs';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)

assertTestProject();
const contextPath=resolve(process.env.ACTIVITY_D2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs/activity')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.suite,'d5');assert.equal(c.schema,'activity_d5_'+hex);assert.equal(c.marker,'clinic-activity-d5:'+c.run);
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);
const client=limit=>{const u=new URL(url);u.searchParams.set('connection_limit',String(limit));return new PrismaClient({datasourceUrl:u.href});};
const db=client(6),op=client(1),auditDb=client(1),apiDb=client(4);
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',prefix='p2.activity-d5.'+c.run,routes=topology(prefix);
const results=[],children=[],evidence={recovery:[],brokerRestart:null,dlq:null,freshness:null};let generation,channel,connection,worker;
const save=()=>writeFileSync(resolve(c.output,'fault-cases.json'),JSON.stringify({run:c.run,schema:c.schema,generation,scope:'LOCAL_FUNCTIONAL_DEV_HOST_NOT_ACCEPTANCE_PROFILE',results,...evidence},null,2));
const mark=(name,extra={})=>{results.push({name,status:'PASS',...extra});save();};
const nap=ms=>new Promise(r=>setTimeout(r,ms));
const readEvents=async since=>(await db.$queryRaw`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE envelope->>'eventType'='clinic.appointment-read-changed.v1' AND "createdAt">=${since}`)[0].n;
// Built V2 worker: same env/process as production; owner role in this fixture.
function startWorker(){
  const p=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...process.env,DATABASE_URL:url.href,BROKER_URL:broker,BROKER_PREFIX:prefix,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1'},stdio:['ignore','pipe','pipe','ipc']});
  children.push(p);p.logs='';p.stdout.on('data',b=>p.logs+=b);p.stderr.on('data',b=>p.logs+=b);return p;
}
const ready=async p=>{const end=Date.now()+30000;while(Date.now()<end){if(p.exitCode!==null)throw new Error('worker exited '+p.logs.slice(-300));if(p.logs.includes('worker-ready'))return;await nap(50);}throw new Error('worker not ready');};
const kill=async p=>{if(p.exitCode===null&&p.signalCode===null){const gone=once(p,'exit');p.kill('SIGKILL');await gone;}};
// Real relay loop (publishes committed outbox rows; retains failures for retry).
let relayStop=false,relayLoop;
function startRelay(){relayStop=false;relayLoop=(async()=>{const relay=new OutboxRelay(db,broker);while(!relayStop){try{if(!await relay.once('d5-relay',routes))await nap(100);}catch{await nap(250);}}})();}
async function stopRelay(){relayStop=true;await relayLoop;}
// Source writer: 20/20/60 create/reschedule/status, each one read-change event.
let ids=[],writes=0;const statuses=['confirmed','cancelled','completed','no_show','pending'];
async function write(i){
  const kind=i%5===0?'create':i%5===1?'reschedule':'status';
  await db.$transaction(async tx=>{
    if(kind==='create'){const id=randomUUID();await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:i%2?'spa_bath':'dental',serviceName:'D5',clinicName:'Fixture',appointmentDate:new Date('2030-10-'+String(1+i%28).padStart(2,'0')),appointmentTime:'06:00'}});await recordAppointmentChange(tx,id,{created:true});ids.push(id);return;}
    const id=ids[(i*7919)%ids.length];await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;
    await tx.appointment.update({where:{id},data:kind==='status'?{status:statuses[i%5]}:{appointmentDate:new Date('2030-09-'+String(1+i%28).padStart(2,'0'))}});
    await recordAppointmentChange(tx,id);
  });writes++;
}
async function writeFor(ms,perSecond){const end=Date.now()+ms;let i=writes;while(Date.now()<end){const t=Date.now();await write(i++);await nap(Math.max(0,1000/perSecond-(Date.now()-t)));}}
async function caughtUp(){
  const rows=await db.$transaction(tx=>reconcileProjection(tx,generation),{timeout:30000});
  if(Object.values(rows).some(n=>n!==0))return false;
  const s=await db.$transaction(tx=>summaryDrift(tx,generation,{source:true}),{timeout:30000});return s.rows===0&&s.source===0;
}
const dlqCount=async()=>(await channel.checkQueue(routes.clinicRead+'.dlq')).messageCount;

test.before(async()=>{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  const f=buildActivityFixture({rows:10000});
  for(let i=0;i<f.appointments.length;i+=2500)await db.appointment.createMany({data:f.appointments.slice(i,i+2500).map(a=>({...a,appointmentDate:new Date(a.appointmentDate),createdAt:new Date(a.createdAt),updatedAt:new Date(a.updatedAt)}))});
  ids=f.appointments.map(a=>a.id);
  await initializeAppointmentProjection(db,randomUUID());
  const engine=new AppointmentRebuild(op),run=randomUUID();generation=randomUUID();
  try{await engine.claim(run,generation,{schemaVersion:2});while(!(await engine.batch(run,2000)).done){}await engine.summarize(run);await engine.verify(run);await engine.activate(run);}finally{await engine.close();}
  await declareTopology(broker,routes);connection=await amqp.connect(broker,{timeout:5000});connection.on('error',()=>{});channel=await connection.createConfirmChannel();channel.on('error',()=>{});
  worker=startWorker();await ready(worker);startRelay();
});
test.after(async()=>{await stopRelay().catch(()=>{});for(const p of children)await kill(p);await channel?.close().catch(()=>{});await connection?.close().catch(()=>{});await Promise.all([db,op,auditDb,apiDb].map(x=>x.$disconnect()));save();});

test('F05 x3: 60s worker outage with <=300 read-change events, catch-up timed from restart, final diffs 0, no valid DLQ',{timeout:900000},async()=>{
  for(let n=1;n<=3;n++){
    await writeFor(3000,4);const steady=Date.now();while(!await caughtUp()){if(Date.now()-steady>30000)throw new Error('not caught up before outage');await nap(250);}
    const since=new Date();await kill(worker);const outageStart=Date.now();
    await writeFor(60000,4.5);const outageSeconds=(Date.now()-outageStart)/1000,backlogEvents=await readEvents(since);
    worker=startWorker();const restarted=Date.now();await ready(worker);
    while(!await caughtUp()){if(Date.now()-restarted>180000)throw new Error('catch-up exceeded 180s');await nap(250);}
    const catchUpSeconds=(Date.now()-restarted)/1000;
    const rows=await db.$transaction(tx=>reconcileProjection(tx,generation),{timeout:30000}),sum=await db.$transaction(tx=>summaryDrift(tx,generation,{source:true}),{timeout:30000});
    const finalMismatches=Object.values(rows).reduce((a,b)=>a+b,0)+sum.rows+sum.source,dlq=await dlqCount();
    evidence.recovery.push({run:n,outageSeconds,backlogEvents,catchUpSeconds,finalMismatches,validDlq:dlq,workerStartIncluded:true});save();
    assert.ok(outageSeconds>=60);assert.ok(backlogEvents>0&&backlogEvents<=300,String(backlogEvents));assert.ok(catchUpSeconds<=120,String(catchUpSeconds));
    assert.equal(finalMismatches,0);assert.equal(dlq,0);
  }
  mark('F05-recovery-3x60s',{runs:evidence.recovery});
});

test('broker restart: outbox retains events while RabbitMQ is down; relay and built worker recover to diff 0',{timeout:600000},async()=>{
  const docker=(...a)=>execFileSync('docker',['compose','-p','pet-phase2-p1-test','-f','deploy/phase2/compose.test.yml',...a],{stdio:'pipe',timeout:120000});
  assertTestProject();assert.equal(docker('exec','-T','rabbitmq','hostname').toString().trim(),'p2-rabbit-test');
  await channel.close().catch(()=>{});await connection.close().catch(()=>{});
  const since=new Date();let stopped=false;
  try{docker('stop','rabbitmq');stopped=true;await writeFor(20000,3);
    const pending=(await db.$queryRaw`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "createdAt">=${since}`)[0].n;assert.ok(pending>0);
    docker('up','-d','--wait','--no-build','--pull','never','rabbitmq');stopped=false;
  }finally{if(stopped)docker('up','-d','--wait','--no-build','--pull','never','rabbitmq');}
  const back=Date.now();connection=await amqp.connect(broker,{timeout:5000});connection.on('error',()=>{});channel=await connection.createConfirmChannel();channel.on('error',()=>{});
  while(!(await caughtUp()&&(await db.$queryRaw`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "publishedAt" IS NULL`)[0].n===0)){if(Date.now()-back>240000)throw new Error('broker recovery exceeded 240s: '+worker.logs.slice(-300));await nap(500);}
  evidence.brokerRestart={events:await readEvents(since),recoverySeconds:(Date.now()-back)/1000,note:'includes relay retry backoff (capped 60s) and worker reconnect'};
  assert.equal(await dlqCount(),0);assert.doesNotMatch(worker.logs,/fixture_only|postgresql:|amqp:\/\//);mark('broker-restart-recovery',evidence.brokerRestart);
});

test('DLQ: poison is isolated; a valid event failing transiently goes to DLQ, then replays once after repair',{timeout:120000},async()=>{
  const poison={eventId:randomUUID(),eventType:'clinic.appointment-read-changed.v1',schemaVersion:1,producer:'clinic',aggregateType:'appointment',aggregateId:'x',aggregateVersion:1,occurredAt:new Date().toISOString(),correlationId:'c',payload:{appointmentId:'x',sourceVersion:1,deleted:false,internalNote:'FORBIDDEN'}};
  // Poison goes to an isolated topology: the existing operator replay tool only
  // replays the DLQ head and parses it, so a poison head would block valid replay.
  const isolated=topology(prefix+'.poison');await declareTopology(broker,isolated);
  const rejector=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...process.env,DATABASE_URL:url.href,BROKER_URL:broker,BROKER_PREFIX:prefix+'.poison',CLINIC_READ_PROJECTOR_POOL_LIMIT:'1'},stdio:['ignore','pipe','pipe','ipc']});
  children.push(rejector);rejector.logs='';rejector.stdout.on('data',b=>rejector.logs+=b);await ready(rejector);
  await publishConfirmed(channel,isolated.exchange,poison.eventType,Buffer.from(JSON.stringify(poison)),{messageId:poison.eventId});
  const p0=Date.now();while((await channel.checkQueue(isolated.clinicRead+'.dlq')).messageCount<1){if(Date.now()-p0>15000)throw new Error('poison not isolated');await nap(200);}
  await kill(rejector);
  // Valid envelope one version AHEAD of the registry: projector refuses (no ACK) -> 2 retries -> DLQ.
  const id=ids[3],[reg]=await db.clinicReadRevision.findMany({where:{aggregateId:id}});
  const ahead={...poison,eventId:randomUUID(),aggregateId:id,aggregateVersion:reg.version+1,payload:{appointmentId:id,sourceVersion:reg.version+1,deleted:false}};
  await publishConfirmed(channel,routes.exchange,ahead.eventType,Buffer.from(JSON.stringify(ahead)),{messageId:ahead.eventId});
  const t=Date.now();while(await dlqCount()<1){if(Date.now()-t>30000)throw new Error('DLQ not reached');await nap(200);}
  assert.equal(await db.inboxEvent.count({where:{eventId:{in:[poison.eventId,ahead.eventId]}}}),0);
  // Repair: the real source change reaches that version (and emits its own event).
  await db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;await tx.appointment.update({where:{id},data:{status:'checked_in'}});await recordAppointmentChange(tx,id);});
  const replayed=await replayEvent(broker,routes.clinicRead,ahead.eventId);assert.equal(replayed.eventId,ahead.eventId);
  const r=Date.now();while(!(await db.inboxEvent.count({where:{eventId:ahead.eventId}})>0&&await caughtUp())){if(Date.now()-r>30000)throw new Error('replay not applied');await nap(200);}
  evidence.dlq={poisonIsolatedQueueDlq:(await channel.checkQueue(isolated.clinicRead+'.dlq')).messageCount,validReplayed:true,remainingMainDlq:await dlqCount(),
    note:'replayEvent replays only the DLQ head; a poison head must be handled separately (existing tooling limit)'};
  assert.equal(evidence.dlq.remainingMainDlq,0);assert.equal(evidence.dlq.poisonIsolatedQueueDlq,1);
  mark('dlq-poison-and-valid-replay',evidence.dlq);
});

test('freshness (functional harness check): 120 mutations at 1/s, one observer at 2/s over the summary reader',{timeout:600000},async()=>{
  process.env.BROKER_URL=broker;process.env.BROKER_PREFIX=prefix;
  const lane=new AuditLane(),rows=new ReadFreshness(auditDb,probeReadQueue,undefined,undefined,{requireListProjection:false,perAggregateLag:true,lane}),sum=new ActivitySummaryEvidence(auditDb,rows,[1,2],lane);
  rows.start();sum.start();const reader=new ClinicActivityQueries(apiDb,'summary',undefined,undefined,sum);
  const f=parseActivityFilter({from:'2035-01-01',to:'2035-12-31',groupBy:'day'});const pending=new Map(),samples=[];let observing=true,fallbacks=0;
  const observer=(async()=>{while(observing){const t=Date.now();try{const r=await reader.read(f);if(r.meta.source!=='summary')fallbacks++;
    else for(const [day,m] of pending){const b=r.current.buckets.find(x=>x.from===day);if(b&&b.byStatus.pending>=1){samples.push(Date.now()-m);pending.delete(day);}}}catch{fallbacks++;}
    for(const [day,m] of pending)if(Date.now()-m>30000){samples.push(null);pending.delete(day);}await nap(Math.max(0,500-(Date.now()-t)));}})();
  try{
    for(let i=0;i<120;i++){const t=Date.now(),day=new Date(Date.UTC(2035,0,1+i)).toISOString().slice(0,10),id=randomUUID();
      await db.$transaction(async tx=>{await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:'other',serviceName:'D5 fresh',clinicName:'Fixture',appointmentDate:new Date(day),appointmentTime:'05:00'}});await recordAppointmentChange(tx,id,{created:true});});
      pending.set(day,Date.now());await nap(Math.max(0,1000-(Date.now()-t)));}
    const end=Date.now();while(pending.size&&Date.now()-end<35000)await nap(200);
  }finally{observing=false;await observer;await sum.close();await rows.close();}
  const finite=samples.map(v=>v??Infinity);
  evidence.freshness={scope:'FUNCTIONAL_HARNESS_CHECK_NOT_POLICY_RUN (policy: 3 runs x >=1000 samples, UI visible p95 on frozen profile)',samples:samples.length,timeouts:samples.filter(v=>v===null).length,
    backendP95Ms:nearestRank(finite,0.95),backendP99Ms:nearestRank(finite,0.99),observerFallbackResponses:fallbacks};
  assert.equal(samples.length,120);mark('freshness-harness-functional',evidence.freshness);
});
