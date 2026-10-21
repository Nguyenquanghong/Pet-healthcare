// D4 real PostgreSQL/RabbitMQ: summary reader parity with source/cached on the D1
// 10k skewed fixture, catch-up parity after projected changes, real ineligibility
// fallbacks, operator control rollback and HTTP. Launched by run-summary-projector.mjs --run-reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import amqp from 'amqplib';
import {assertTestProject,waitForQueueIdle} from '../../test-project.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {recordAppointmentChange,initializeAppointmentProjection} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentProjector} from '../../../../services/clinic/dist/appointmentProjector.js';
import {AppointmentRebuild} from '../../../../services/clinic/dist/readRebuild.js';
import {ReadFreshness,probeReadQueue} from '../../../../services/clinic/dist/readFreshness.js';
import {ActivitySummaryEvidence,AuditLane} from '../../../../services/clinic/dist/activitySummaryEvidence.js';
import {ClinicActivityQueries} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';
import {parseActivityFilter} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {createApp} from '../../../../services/clinic/dist/app.js';
import {topology,declareTopology,consumeEvents,publishConfirmed} from '../../../../packages/messaging/dist/index.js';
import {buildActivityFixture} from './fixture.mjs';

assertTestProject();
const contextPath=resolve(process.env.ACTIVITY_D2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs/activity')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.suite,'d4');assert.equal(c.schema,'activity_d4_'+hex);assert.equal(c.marker,'clinic-activity-d4:'+c.run);
assert.deepEqual(c.roles,{projector:'act_d4_p_'+hex,reader:'act_d4_r_'+hex});
const client=limit=>{const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit',String(limit));return new PrismaClient({datasourceUrl:url.href});};
const asRole=(base,role)=>new Proxy(base,{get(t,k){if(k==='$transaction')return (work,options)=>t.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);return work(tx);},options);const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
// db: owner (source writer/operator fixture). api/audit: activity reader role (SELECT-only). worker: projector role.
const db=client(6),op=client(1),apiBase=client(4),auditBase=client(1),workerBase=client(2);
const api=asRole(apiBase,c.roles.reader),audit=asRole(auditBase,c.roles.reader),worker=asRole(workerBase,c.roles.projector);
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',prefix='p2.activity-d4.'+c.run,routes=topology(prefix);
const results=[],timings={},generations={};let consumer,connection,channel,offset=0;
const mark=(name,extra={})=>{results.push({name,status:'PASS',...extra});writeFileSync(resolve(c.output,'cases.json'),JSON.stringify({run:c.run,schema:c.schema,generations,timings,results,queues:routes,retained:true},null,2));};
const lane=new AuditLane(),rows=new ReadFreshness(audit,probeReadQueue,undefined,undefined,{requireListProjection:false,perAggregateLag:true,lane});
const evidence=new ActivitySummaryEvidence(audit,rows,[1,2],lane,()=>Date.now()+offset);
const sample=async()=>{await rows.sample();await evidence.sample();};
const reader=mode=>new ClinicActivityQueries(api,mode,undefined,undefined,evidence);
const business=r=>{const {meta,...rest}=r;return rest;};
const filters=[{from:'2030-09-21',to:'2030-10-20'},{from:'2030-10-20',to:'2030-10-20'},{from:'2029-10-20',to:'2030-10-20'},{from:'2029-11-01',to:'2030-10-20',groupBy:'month'},
  {from:'2028-02-27',to:'2028-03-02'},{from:'2027-01-01',to:'2027-12-31',groupBy:'month'}].flatMap(f=>['all','clinic','spa'].map(category=>parseActivityFilter({...f,category})));
async function rebuild(schemaVersion){const engine=new AppointmentRebuild(op),run=randomUUID(),g=randomUUID();const t=performance.now();
  try{await engine.claim(run,g,{schemaVersion});while(!(await engine.batch(run,2000)).done){}if(schemaVersion===2)await engine.summarize(run);await engine.verify(run);await engine.activate(run);}finally{await engine.close();}
  return {g,ms:Math.round(performance.now()-t)};}
async function parity(label){
  const summary=reader('summary'),source=reader('source'),cached=reader('cached');let n=0;
  for(const f of filters){
    const p=await summary.read(f),s=await source.read(f);
    assert.equal(p.meta.source,'summary',label+' '+JSON.stringify(f)+' '+p.meta.reason);assert.equal(p.meta.generation,generations.active);
    assert.deepEqual(business(p),business(s),label+' '+JSON.stringify(f));
    await cached.read(f);const ch=await cached.read(f);assert.equal(ch.meta.source,'cached');assert.deepEqual(business(ch),business(s));n++;
  }
  return n;
}
async function write(id,patch={},{created=false,deleted=false}={}){
  const raw=await db.$transaction(async tx=>{
    if(created)await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:'vaccination',serviceName:'D4',clinicName:'Fixture',appointmentDate:new Date('2030-10-20'),appointmentTime:'07:00',...patch}});
    else{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;if(deleted){await tx.appointment.delete({where:{id}});}else await tx.appointment.update({where:{id},data:patch});}
    const {eventId}=await recordAppointmentChange(tx,id,{created,deleted});
    return JSON.stringify((await tx.outboxEvent.findUniqueOrThrow({where:{id:eventId}})).envelope);
  });
  const e=JSON.parse(raw);await publishConfirmed(channel,routes.exchange,e.eventType,Buffer.from(raw),{messageId:e.eventId,contentType:'application/json'});
}
const startConsumer=async()=>{consumer=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>new AppointmentProjector(worker).apply(raw));};

test.before(async()=>{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  const fixture=buildActivityFixture({rows:10000});timings.fixtureSha256=fixture.manifest.contentSha256;
  for(let i=0;i<fixture.appointments.length;i+=2500)await db.appointment.createMany({data:fixture.appointments.slice(i,i+2500).map(a=>({...a,appointmentDate:new Date(a.appointmentDate),createdAt:new Date(a.createdAt),updatedAt:new Date(a.updatedAt)}))});
  await initializeAppointmentProjection(db,randomUUID());
  const v2=await rebuild(2);generations.active=v2.g;generations.firstV2=v2.g;timings.rebuild10kMs=v2.ms;
  process.env.BROKER_URL=broker;process.env.BROKER_PREFIX=prefix;await declareTopology(broker,routes);
  connection=await amqp.connect(broker,{timeout:5000});connection.on('error',()=>{});channel=await connection.createConfirmChannel();channel.on('error',()=>{});
  await startConsumer();await sample();
});
test.after(async()=>{await consumer?.close().catch(()=>{});await channel?.close().catch(()=>{});await connection?.close().catch(()=>{});await Promise.all([db,op,apiBase,auditBase,workerBase].map(x=>x.$disconnect()));});

test('A04: summary business DTO equals source and cached for 18 filters on the 10k skewed fixture (reader role)',async()=>{
  assert.equal(evidence.ineligibleReason(generations.active),undefined,evidence.failure);
  const t=performance.now();const n=await parity('initial');timings.parityMs=Math.round(performance.now()-t);
  assert.equal((await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).servingMode,'authoritative');
  mark('A04-parity-initial',{filters:n,fixtureSha256:timings.fixtureSha256});
});

test('A07/A08 catch-up: projected creates, transfers, reschedules, notes and tombstones keep summary == source',async()=>{
  const sampleIds=(await db.appointment.findMany({take:40,orderBy:{id:'asc'},select:{id:true}})).map(r=>r.id);
  const statuses=['cancelled','no_show','completed','confirmed'];
  for(const [i,id] of sampleIds.entries()){
    if(i%5===0)await write(id,{appointmentDate:new Date('2030-10-'+String(10+i%10).padStart(2,'0'))});
    else if(i%5===1)await write(id,{type:'spa_combo'});
    else if(i%5===2)await write(id,{ownerNote:'D4 note '+i});
    else if(i%5===3)await write(id,{},{deleted:true});
    else await write(id,{status:statuses[i%4]});
  }
  for(let i=0;i<10;i++)await write(randomUUID(),{status:i%2?'pending':'checked_in'},{created:true});
  await waitForQueueIdle([routes.clinicRead],30000);await sample();
  assert.equal(evidence.ineligibleReason(generations.active),undefined,evidence.failure);
  mark('A07-A08-catch-up-parity',{filters:await parity('catch-up'),writes:50});
});

test('F02-F04: frozen run, drift, expired evidence and broker loss make summary fall back to the whole source response',async()=>{
  const g=generations.active,f=filters[0],p=reader('summary');
  const engine=new AppointmentRebuild(op),run=randomUUID();await engine.claim(run,randomUUID(),{schemaVersion:2});
  try{const r=await p.read(f);assert.deepEqual([r.meta.source,r.meta.reason,r.meta.degraded],['source','summary_frozen',true]);}finally{await engine.abort(run);await engine.close();}
  await sample();assert.equal((await p.read(f)).meta.source,'summary');
  const [k]=await db.$queryRaw`SELECT "appointmentDate"::text AS d,type::text AS t,status::text AS s FROM "AppointmentDailySummary" WHERE generation=${g} ORDER BY 1 DESC,2,3 LIMIT 1`;
  const nudge=n=>db.$executeRaw`UPDATE "AppointmentDailySummary" SET "appointmentCount"="appointmentCount"+${n} WHERE generation=${g} AND "appointmentDate"=CAST(${k.d} AS date) AND type=CAST(${k.t} AS "AppointmentType") AND status=CAST(${k.s} AS "AppointmentStatus")`;
  assert.equal(await nudge(1),1);await evidence.sample();
  let r=await p.read(f);assert.deepEqual([r.meta.source,r.meta.reason],['source','summary_drift']);
  assert.deepEqual(business(r),business(await reader('source').read(f)),'fallback is the authoritative answer, not the drifted counter');
  assert.equal(await nudge(-1),1);await sample();assert.equal((await p.read(f)).meta.source,'summary');
  offset=60_001;r=await p.read(f);assert.equal(r.meta.reason,'summary_evidence_expired');offset=0;
  await consumer.close();await rows.sample();r=await p.read(f);assert.deepEqual([r.meta.source,r.meta.reason],['source','rows_freshness_missing']);
  await startConsumer();await sample();assert.equal((await p.read(f)).meta.source,'summary');
  mark('F02-F04-real-fallbacks');
});

test('F02 V1/incomplete generation: V1 ACTIVE or a building V2 never serves summary; a new V2 needs its own evidence',{timeout:300000},async()=>{
  const f=filters[0],p=reader('summary');
  await consumer.close();const v1=await rebuild(1);generations.v1=v1.g;await startConsumer();await sample();
  let r=await p.read(f);assert.deepEqual([r.meta.source,r.meta.reason],['source','summary_not_v2']);
  const engine=new AppointmentRebuild(op),run=randomUUID(),building=randomUUID();await engine.claim(run,building,{schemaVersion:2});await engine.batch(run,2000);
  // The pointer still names V1 while a V2 is BUILDING under the fence.
  try{r=await p.read(f);assert.equal(r.meta.reason,'summary_not_v2');}finally{await engine.abort(run);await engine.close();}
  await consumer.close();const v2=await rebuild(2);generations.active=v2.g;await startConsumer();
  r=await p.read(f);assert.deepEqual([r.meta.source,r.meta.reason],['source','summary_evidence_generation']);
  await sample();r=await p.read(f);assert.equal(r.meta.source,'summary');assert.equal(r.meta.generation,v2.g);
  mark('F02-v1-building-new-generation',{rebuildV1Ms:v1.ms,rebuildV2Ms:v2.ms});
});

test('operator control: summary -> source rollback and cached take effect on next poll; list mode untouched',async()=>{
  const f=filters[0],q=new ClinicActivityQueries(api,'control',undefined,undefined,evidence,1000);
  for(const [mode,expected] of [['summary','summary'],['source','source'],['cached','source'],['cached','cached'],['summary','summary']]){
    await db.clinicActivityControl.update({where:{id:1},data:{servingMode:mode}});await q.refreshControl();
    const r=await q.read(f);assert.equal(r.meta.source,expected,mode);assert.equal(r.meta.degraded,false);
  }
  await db.clinicActivityControl.update({where:{id:1},data:{servingMode:'source'}});
  assert.equal((await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).servingMode,'authoritative');
  mark('control-rollback');
});

test('HTTP on real PG: admin summary with generation header; roles/validation denied without fallback',async()=>{
  const previous={mode:process.env.CLINIC_ACTIVITY_MODE,read:process.env.CLINIC_READ_MODE};process.env.CLINIC_ACTIVITY_MODE='summary';process.env.CLINIC_READ_MODE='authoritative';
  const actors={admin:{sub:randomUUID(),role:'admin'},owner:{sub:randomUUID(),role:'owner'},doctor:{sub:randomUUID(),role:'doctor'}};
  const directory={acceptsService:()=>true,request:async actor=>({actor:{...actor,fullName:'D4'},pets:[],owners:[]})};
  const server=createApp(api,t=>{if(!actors[t])throw new Error('invalid');return actors[t];},directory,undefined,undefined,evidence).listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port,get=(path,token='admin')=>fetch(base+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
  try{
    const r=await get('/api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20'),body=await r.json();
    assert.equal(r.status,200);assert.equal(body.meta.source,'summary');assert.equal(r.headers.get('x-clinic-projection-generation'),generations.active);
    assert.equal((await get('/api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20','owner')).status,403);
    assert.equal((await get('/api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20','doctor')).status,403);
    assert.equal((await get('/api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20','nobody')).status,401);
    assert.equal((await get('/api/dashboard/clinic/activity?from=2030-10-21&to=2030-10-20')).status,422);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));process.env.CLINIC_ACTIVITY_MODE=previous.mode;process.env.CLINIC_READ_MODE=previous.read;if(previous.mode===undefined)delete process.env.CLINIC_ACTIVITY_MODE;if(previous.read===undefined)delete process.env.CLINIC_READ_MODE;}
  mark('http-real-pg');
});
