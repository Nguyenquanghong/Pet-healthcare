// D2 real RabbitMQ + PostgreSQL cases: SIGKILL inside the V2 transaction and after
// commit/before ACK, then redelivery; built read worker capability at startup.
// Launched by run-summary-projector.mjs after summary.integration.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import amqp from 'amqplib';
import {assertTestProject,waitForQueueIdle} from '../../test-project.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {recordAppointmentChange} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentProjector} from '../../../../services/clinic/dist/appointmentProjector.js';
import {topology,declareTopology,consumeEvents,publishConfirmed} from '../../../../packages/messaging/dist/index.js';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)

assertTestProject();
const contextPath=resolve(process.env.ACTIVITY_D2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs/activity')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.schema,'activity_d2_'+hex);assert.equal(c.marker,'clinic-activity-d2:'+c.run);assert.equal(c.roles.projector,'act_d2_p_'+hex);
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','4');
const db=new PrismaClient({datasourceUrl:url.href}),broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',prefix='p2.activity-d2.'+c.run,routes=topology(prefix);
const asRole=base=>new Proxy(base,{get(t,k){if(k==='$transaction')return (work,options)=>t.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL ROLE "${c.roles.projector}"`);return work(tx);},options);const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
const v2=randomUUID(),results=[],children=[];let connection,channel;
const mark=name=>{results.push({name,status:'PASS'});writeFileSync(resolve(c.output,'broker-cases.json'),JSON.stringify({run:c.run,schema:c.schema,generation:v2,queues:routes,results,retained:true},null,2));};
const nap=ms=>new Promise(r=>setTimeout(r,ms));
async function until(work,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const v=await work();if(v)return v;await nap(25);}throw new Error('Timeout '+label);}
const send=raw=>{const e=JSON.parse(raw);return publishConfirmed(channel,routes.exchange,e.eventType,Buffer.from(raw),{messageId:e.eventId,contentType:'application/json'});};
const leaks=/fixture_only|postgresql:|amqp:\/\/|D2_PRIVATE/;
let day=0;const nextDay=()=>new Date(Date.UTC(2031,0,1+day++)).toISOString().slice(0,10);
async function write(id,patch={},created=false){
  return db.$transaction(async tx=>{
    if(created)await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:'dermatology',serviceName:'D2 broker',clinicName:'Fixture',appointmentDate:new Date(nextDay()),appointmentTime:'10:00',internalNote:'D2_PRIVATE',...patch}});
    else{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;await tx.appointment.update({where:{id},data:patch});}
    const {eventId}=await recordAppointmentChange(tx,id,{created});
    return JSON.stringify((await tx.outboxEvent.findUniqueOrThrow({where:{id:eventId}})).envelope);
  });
}
const count=async(id,status)=>{const a=await db.appointment.findUniqueOrThrow({where:{id}});const [r]=await db.$queryRaw`SELECT "appointmentCount" AS n FROM "AppointmentDailySummary" WHERE generation=${v2} AND "appointmentDate"=CAST(${a.appointmentDate.toISOString().slice(0,10)} AS date) AND type=CAST(${a.type} AS "AppointmentType") AND status=CAST(${status} AS "AppointmentStatus")`;return r?.n??0n;};
const inbox=eventId=>db.inboxEvent.count({where:{eventId}});
const row=id=>db.appointmentReadRow.findUnique({where:{generation_appointmentId:{generation:v2,appointmentId:id}}});
async function rowsMatchSummary(){const [r]=await db.$queryRaw`WITH m AS (SELECT "appointmentDate" d,type t,status s,"appointmentCount" n FROM "AppointmentDailySummary" WHERE generation=${v2} AND "appointmentCount"<>0),
  r AS (SELECT "appointmentDate" d,type t,status s,count(*)::bigint n FROM "AppointmentReadRow" WHERE generation=${v2} AND "deletedAt" IS NULL GROUP BY 1,2,3)
  SELECT count(*)::int AS n FROM r FULL JOIN m USING (d,t,s) WHERE r.n IS DISTINCT FROM m.n`;return r.n;}
async function consumeUntil(check,label){
  const projector=new AppointmentProjector(asRole(db)),worker=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));
  try{await until(check,label);await waitForQueueIdle([routes.clinicRead]);}finally{await worker.close();}
  return projector;
}
function child(mode){
  const p=spawn(process.execPath,['tools/phase2/cqrs/activity/summary-broker-child.mjs',mode],{env:{...process.env,ACTIVITY_D2_CONTEXT:contextPath},stdio:['ignore','pipe','pipe','ipc']});children.push(p);
  p.stages=new Set();p.logs='';p.stdout.on('data',b=>p.logs+=b);p.stderr.on('data',b=>p.logs+=b);p.on('message',m=>{if(m?.stage)p.stages.add(m.stage);});return p;
}
function builtWorker(extra={}){
  const p=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...process.env,DATABASE_URL:url.href,BROKER_URL:broker,BROKER_PREFIX:prefix,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1',...extra},stdio:['ignore','pipe','pipe','ipc']});children.push(p);
  p.logs='';p.stdout.on('data',b=>p.logs+=b);p.stderr.on('data',b=>p.logs+=b);return p;
}
const kill=async p=>{const gone=once(p,'exit');p.kill('SIGKILL');await gone;};

test.before(async()=>{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  // Previous PG cases retired their V2 generation. A fresh V2 BUILDING target
  // (fixture, not rebuild) sits beside V1; only appointments created here are counted.
  const targets=await db.readProjectionGeneration.findMany({where:{state:{in:['BUILDING','READY','ACTIVE']}}});
  assert.deepEqual(targets.map(g=>g.schemaVersion),[1]);
  await db.readProjectionGeneration.create({data:{id:v2,schemaVersion:2}});
  connection=await amqp.connect(broker,{timeout:5000});connection.on('error',()=>{});channel=await connection.createConfirmChannel();channel.on('error',()=>{});
  await declareTopology(broker,routes);
});
test.after(async()=>{
  for(const p of children)if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await once(p,'exit');}
  await channel?.close().catch(()=>{});await connection?.close().catch(()=>{});await db.$disconnect();
});

test('SIGKILL inside V2 transaction after counter increment rolls back; redelivery counts once',{timeout:60000},async()=>{
  const id=randomUUID(),raw=await write(id,{},true),eventId=JSON.parse(raw).eventId,p=child('before-commit');
  await until(()=>{if(p.exitCode!==null)throw new Error('child exited '+p.logs);return p.stages.has('ready');},'child ready');
  await send(raw);await until(()=>p.stages.has('before-commit'),'paused after increment');
  await kill(p);
  assert.equal(await inbox(eventId),0);assert.equal(await row(id),null);assert.equal(await count(id,'pending'),0n);
  await consumeUntil(async()=>(await inbox(eventId))===2,'redelivered after rollback');
  assert.equal(await count(id,'pending'),1n);assert.equal((await row(id)).sourceVersion,1);assert.equal(await rowsMatchSummary(),0);
  assert.doesNotMatch(p.logs,leaks);mark('kill-before-commit-redelivery');
});

test('SIGKILL after commit before ACK: redelivered transfer is a duplicate, counters unchanged',{timeout:60000},async()=>{
  const id=randomUUID();await send(await write(id,{},true));await consumeUntil(async()=>!!(await row(id)),'initial projection');
  const raw=await write(id,{status:'cancelled'}),eventId=JSON.parse(raw).eventId,p=child('after-commit');
  await until(()=>{if(p.exitCode!==null)throw new Error('child exited '+p.logs);return p.stages.has('ready');},'child ready');
  await send(raw);await until(()=>p.stages.has('after-commit'),'committed before ack');
  await kill(p);
  assert.equal(await inbox(eventId),2);assert.equal(await count(id,'cancelled'),1n);assert.equal(await count(id,'pending'),0n);
  const projector=await consumeUntil(async()=>true,'redelivery drained');
  assert.ok(projector.stats.duplicates>=1);assert.equal(projector.stats.applied,0);
  assert.equal(await inbox(eventId),2);assert.equal(await count(id,'cancelled'),1n);assert.equal(await count(id,'pending'),0n);
  assert.equal(await rowsMatchSummary(),0);assert.doesNotMatch(p.logs,leaks);mark('kill-after-commit-before-ack-duplicate');
});

test('built V1-only read worker refuses a V2 target before consuming; built V1+V2 worker drains it',{timeout:90000},async()=>{
  const id=randomUUID(),raw=await write(id,{},true),eventId=JSON.parse(raw).eventId;await send(raw);
  for(const value of ['1','v2']){
    const p=builtWorker({CLINIC_READ_PROJECTION_VERSIONS:value});const [code]=await once(p,'exit');
    assert.equal(code,1,value);assert.match(p.logs,/WORKER_START_FAILED/);assert.doesNotMatch(p.logs,/worker-ready/);assert.doesNotMatch(p.logs,leaks);
  }
  assert.equal((await channel.checkQueue(routes.clinicRead)).messageCount,1);assert.equal(await inbox(eventId),0);
  const p=builtWorker();
  const ready=await until(()=>{if(p.exitCode!==null)throw new Error('built worker exited');const line=p.logs.split('\n').find(l=>l.includes('worker-ready'));return line&&JSON.parse(line);},'built worker ready',30000);
  assert.deepEqual([ready.projectionVersions,ready.summaryEnabled,ready.prefetch],[[1,2],true,1]);
  await until(async()=>(await inbox(eventId))===2,'built worker applied');await waitForQueueIdle([routes.clinicRead]);
  assert.equal(await count(id,'pending'),1n);assert.equal(await rowsMatchSummary(),0);
  p.send({type:'shutdown'});const [code]=await once(p,'exit');assert.equal(code,0);assert.doesNotMatch(p.logs,leaks);
  assert.equal((await channel.checkQueue(routes.clinicRead+'.dlq')).messageCount,0);
  mark('built-worker-capability-startup');
});
