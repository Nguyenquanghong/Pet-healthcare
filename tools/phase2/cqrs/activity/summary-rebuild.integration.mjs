// D3 real PostgreSQL/RabbitMQ cases: V2 rebuild (rows -> canonical summary),
// verify source<->rows<->summary, CAS activate, crash/resume/abort, drift, replay,
// and list-independent evidence. Launched only by run-summary-projector.mjs --run-rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {assertTestProject,waitForQueueIdle} from '../../test-project.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {recordAppointmentChange,initializeAppointmentProjection} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentProjector} from '../../../../services/clinic/dist/appointmentProjector.js';
import {AppointmentRebuild} from '../../../../services/clinic/dist/readRebuild.js';
import {reconcileProjection} from '../../../../services/clinic/dist/projectionSnapshot.js';
import {summaryDrift} from '../../../../services/clinic/dist/clinicActivitySummary.js';
import {ReadFreshness,probeReadQueue} from '../../../../services/clinic/dist/readFreshness.js';
import {ActivitySummaryEvidence,AuditLane} from '../../../../services/clinic/dist/activitySummaryEvidence.js';
import {topology,declareTopology,consumeEvents} from '../../../../packages/messaging/dist/index.js';

assertTestProject();
const contextPath=resolve(process.env.ACTIVITY_D2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs/activity')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.suite,'d3');assert.equal(c.schema,'activity_d3_'+hex);assert.equal(c.marker,'clinic-activity-d3:'+c.run);
assert.deepEqual(c.roles,{projector:'act_d3_p_'+hex,reader:'act_d3_r_'+hex});
const client=limit=>{const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit',String(limit));return new PrismaClient({datasourceUrl:url.href});};
// db: source writer/fixture/assertions. op: operator, ONE connection (fence is
// owned by backend PID). worker/audit: restricted projector/reader roles.
const db=client(6),op=client(1),workerBase=client(2),auditBase=client(1);
const asRole=(base,role)=>new Proxy(base,{get(t,k){if(k==='$transaction')return (work,options)=>t.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);return work(tx);},options);const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
const worker=asRole(workerBase,c.roles.projector),audit=asRole(auditBase,c.roles.reader),engine=new AppointmentRebuild(op);
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',prefix='p2.activity-d3.'+c.run,routes=topology(prefix);
const v1=randomUUID(),results=[],children=[],timings={};const generations={};
const mark=(name,extra={})=>{results.push({name,status:'PASS',...extra});writeFileSync(resolve(c.output,'cases.json'),JSON.stringify({run:c.run,schema:c.schema,generations,timings,results,queues:routes,retained:true},null,2));};
const pg=code=>e=>e?.meta?.code===code||String(e?.message).includes(code);
const projector=()=>new AppointmentProjector(worker);
async function write(id,patch={},{created=false,deleted=false}={}){
  return db.$transaction(async tx=>{
    if(created)await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:'general_checkup',serviceName:'D3 fixture',clinicName:'Fixture',appointmentDate:new Date('2030-10-20'),appointmentTime:'08:00',...patch}});
    else{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;if(deleted){await tx.appointmentReservation.deleteMany({where:{appointmentId:id}});await tx.appointment.delete({where:{id}});}else if(Object.keys(patch).length)await tx.appointment.update({where:{id},data:patch});}
    const {eventId}=await recordAppointmentChange(tx,id,{created,deleted});
    return JSON.stringify((await tx.outboxEvent.findUniqueOrThrow({where:{id:eventId}})).envelope);
  },{timeout:15000});
}
const control=()=>db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}});
const activityMode=async()=>(await db.clinicActivityControl.findUniqueOrThrow({where:{id:1}})).servingMode;
const generation=id=>db.readProjectionGeneration.findUniqueOrThrow({where:{id}});
// Operator-equivalent 30s budget: right after a 100k bulk load the cold/unanalyzed
// full reconciliation can exceed Prisma's 5s default. Durations are recorded.
const drift=async g=>{const t=performance.now(),r=await db.$transaction(tx=>summaryDrift(tx,g,{source:true}),{timeout:30000});(timings.driftMs??=[]).push(Math.round(performance.now()-t));return r;};
const rowsDiff=g=>db.$transaction(tx=>reconcileProjection(tx,g),{timeout:30000});
const zero=o=>Object.values(o).every(n=>n===0);
async function rebuildV2(run,g){const t=performance.now();await engine.claim(run,g,{schemaVersion:2});while(!(await engine.batch(run,2000)).done){}await engine.summarize(run);const diff=await engine.verify(run);const result=await engine.activate(run);const freezeMs=Math.round(performance.now()-t);await engine.close();return {diff,result,freezeMs};}
function child(mode,run,g){
  const p=spawn(process.execPath,['tools/phase2/cqrs/activity/summary-rebuild-child.mjs',mode,run,g],{env:{...process.env,ACTIVITY_D3_CONTEXT:contextPath},stdio:['ignore','pipe','pipe','ipc']});children.push(p);
  p.logs='';p.stdout.on('data',b=>p.logs+=b);p.stderr.on('data',b=>p.logs+=b);return p;
}
async function crashAt(mode,run,g){
  const p=child(mode,run,g);const [m]=await once(p,'message');assert.equal(m.stage,mode,JSON.stringify(m)+p.logs);
  const gone=once(p,'exit');p.kill('SIGKILL');await gone;assert.doesNotMatch(p.logs,/fixture_only|postgresql:|amqp:\/\//);
}
async function assertFenced(){
  await assert.rejects(db.appointment.updateMany({data:{clinicName:'Blocked'}}),pg('CLINIC_READ_REBUILD_FROZEN'));
  const id=(await db.appointment.findFirstOrThrow({select:{id:true}})).id;const [r]=await db.clinicReadRevision.findMany({where:{aggregateId:id}});
  const raw=JSON.stringify({eventId:randomUUID(),eventType:'clinic.appointment-read-changed.v1',schemaVersion:1,producer:'clinic',aggregateType:'appointment',aggregateId:id,aggregateVersion:r.version,occurredAt:new Date().toISOString(),correlationId:randomUUID(),payload:{appointmentId:id,sourceVersion:r.version,deleted:false}});
  await assert.rejects(projector().apply(raw),pg('CLINIC_READ_REBUILD_FROZEN'));
}

test.before(async()=>{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  await initializeAppointmentProjection(db,v1);generations.initialV1=v1;
  await declareTopology(broker,routes);
});
test.after(async()=>{
  for(const p of children)if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await once(p,'exit');}
  await engine.close().catch(()=>{});await Promise.all([db,op,workerBase,auditBase].map(x=>x.$disconnect()));
});

test('R01 zero source: new V2 generation activates by CAS; activity source, list authoritative, fence released',async()=>{
  const run=randomUUID(),g=randomUUID();generations.zero=g;
  const {diff,result,freezeMs}=await rebuildV2(run,g);timings.zeroFreezeMs=freezeMs;
  assert.ok(zero(diff));assert.deepEqual(Object.keys(diff).filter(k=>k.startsWith('summary')),['summaryRows','summarySource']);
  assert.deepEqual(result,{generation:g,schemaVersion:2,servingMode:'authoritative',activityServingMode:'source'});
  assert.equal((await control()).activeGenerationId,g);assert.equal((await generation(g)).state,'ACTIVE');assert.equal((await generation(v1)).state,'RETIRED');
  assert.equal(await db.appointmentDailySummary.count({where:{generation:g}}),0);assert.equal(await activityMode(),'source');
  assert.equal((await db.readRebuildRun.findUniqueOrThrow({where:{id:run}})).frozen,false);
  mark('R01-zero',{freezeMs});
});

test('R01 one + R03: backlog event after rebuild hydrates the same version; counter untouched',async()=>{
  // Activity mode set by an operator to summary must be forced back to source by a rebuild.
  await db.clinicActivityControl.update({where:{id:1},data:{servingMode:'summary'}});
  const id=randomUUID(),backlog=await write(id,{},{created:true}),run=randomUUID(),g=randomUUID();generations.one=g;
  const {diff,freezeMs}=await rebuildV2(run,g);assert.ok(zero(diff));timings.oneFreezeMs=freezeMs;
  assert.equal(await activityMode(),'source');assert.equal((await generation(generations.zero)).state,'RETIRED');
  const [bucket]=await db.$queryRaw`SELECT "appointmentCount" AS n,xmin::text AS x FROM "AppointmentDailySummary" WHERE generation=${g}`;assert.equal(bucket.n,1n);
  assert.equal(await projector().apply(backlog),true);
  const [after]=await db.$queryRaw`SELECT "appointmentCount" AS n,xmin::text AS x FROM "AppointmentDailySummary" WHERE generation=${g}`;assert.deepEqual(after,bucket);
  assert.deepEqual(await drift(g),{rows:0,source:0});mark('R01-one-R03-backlog',{freezeMs});
});

test('R01 100k + R02: crash after batch, after summary and after verify keeps fence/pointer; resume activates exactly',{timeout:600000},async()=>{
  // Deterministic skew: 92 days with empty days, a hot day, weighted types/statuses.
  const types=['general_checkup','general_checkup','vaccination','dental','dermatology','surgery','hotel_consultation','spa_bath','spa_grooming','spa_combo','other'];
  const statuses=['pending','confirmed','confirmed','checked_in','in_progress','completed','completed','completed','cancelled','no_show'];
  const day=i=>{if(i%20===0)return '2030-10-20';let d=i%92;if(d%13===5)d=(d+1)%92;return new Date(Date.UTC(2030,7,1+d)).toISOString().slice(0,10);};
  const t0=performance.now();
  for(let start=0;start<100000;start+=5000)await db.appointment.createMany({data:Array.from({length:5000},(_,j)=>{const i=start+j;return {id:randomUUID(),petId:randomUUID(),ownerId:randomUUID(),type:types[i%types.length],status:statuses[(i*7)%statuses.length],serviceName:'D3 100k',clinicName:'Fixture',appointmentDate:new Date(day(i)),appointmentTime:String(8+i%10).padStart(2,'0')+':'+String(i%60).padStart(2,'0'),ownerNote:i%9?null:'note',internalNote:i%11?null:'D3_PRIVATE'};})});
  timings.seed100kMs=Math.round(performance.now()-t0);
  const before=(await control()).activeGenerationId,run=randomUUID(),g=randomUUID();generations.large=g;const freezeStart=performance.now();
  await crashAt('after-batch',run,g);
  let r=await db.readRebuildRun.findUniqueOrThrow({where:{id:run}});assert.deepEqual([r.frozen,r.state,r.copied],[true,'BUILDING',2000]);
  assert.equal((await control()).activeGenerationId,before);await assertFenced();
  // A second operator cannot start another frozen run while this one is unresolved.
  const rivalDb=client(1),rival=new AppointmentRebuild(rivalDb);
  await assert.rejects(rival.claim(randomUUID(),randomUUID(),{schemaVersion:2}),e=>/ReadRebuildRun_one_frozen|Unique constraint|P2002/.test(String(e?.message)+e?.code));await rival.close();await rivalDb.$disconnect();
  await crashAt('after-summary',run,g);
  r=await db.readRebuildRun.findUniqueOrThrow({where:{id:run}});assert.deepEqual([r.state,r.copied],['BUILDING',100001]);
  assert.equal((await generation(g)).state,'BUILDING');assert.ok(await db.appointmentDailySummary.count({where:{generation:g}})>0);assert.equal((await control()).activeGenerationId,before);
  await crashAt('after-verify',run,g);
  assert.equal((await generation(g)).state,'READY');assert.equal((await control()).activeGenerationId,before);await assertFenced();
  await engine.claim(run,g,{schemaVersion:2});const result=await engine.activate(run);timings.largeFreezeMs=Math.round(performance.now()-freezeStart);await engine.close();
  assert.equal(result.generation,g);assert.equal((await control()).activeGenerationId,g);assert.equal((await generation(before)).state,'RETIRED');
  const [sum]=await db.$queryRaw`SELECT sum("appointmentCount")::bigint AS n,count(*)::int AS buckets FROM "AppointmentDailySummary" WHERE generation=${g}`;
  assert.equal(sum.n,100001n);assert.deepEqual(await drift(g),{rows:0,source:0});assert.ok(zero(await rowsDiff(g)));
  // Crash "after switch" leaves nothing to resume: run COMPLETE, fence off, writers proceed.
  // A refused claim keeps the operator advisory lock until close(), like the CLI's finally.
  await assert.rejects(engine.claim(run,g,{abortOnly:true,schemaVersion:2}),/REBUILD_NOT_RESUMABLE/);await engine.close();
  assert.equal((await db.appointment.updateMany({where:{id:'missing'},data:{clinicName:'x'}})).count,0);
  assert.equal(await activityMode(),'source');assert.equal((await control()).servingMode,'authoritative');
  mark('R01-100k-R02-crash-resume',{rows:100001,buckets:sum.buckets,freezeMs:timings.largeFreezeMs,seedMs:timings.seed100kMs});
});

test('R04/R06: summary corruption, source drift and pointer change block READY/activation; abort retires and keeps evidence',{timeout:300000},async()=>{
  const active=(await control()).activeGenerationId,run=randomUUID(),g=randomUUID();generations.aborted=g;
  const t=performance.now();await engine.claim(run,g,{schemaVersion:2});while(!(await engine.batch(run,2000)).done){}await engine.summarize(run);
  timings.clean100kBuildMs=Math.round(performance.now()-t);await assertFenced();
  // Operator session owns the fence, so it can inject faults for the checks.
  await op.$executeRaw`UPDATE "AppointmentDailySummary" SET "appointmentCount"="appointmentCount"+1 WHERE generation=${g} AND ctid=(SELECT ctid FROM "AppointmentDailySummary" WHERE generation=${g} LIMIT 1)`;
  await assert.rejects(engine.verify(run),/REBUILD_SUMMARY_MISMATCH/);
  await engine.summarize(run);await engine.verify(run);
  const victim=await op.appointment.findFirstOrThrow({select:{id:true,clinicName:true}});
  await op.$executeRaw`UPDATE appointments SET clinic_name='Drifted' WHERE id=${victim.id}`;
  await assert.rejects(engine.activate(run),/REBUILD_SOURCE_DRIFT/);
  await op.$executeRaw`UPDATE appointments SET clinic_name=${victim.clinicName} WHERE id=${victim.id}`;
  await op.$executeRaw`UPDATE "ReadProjectionControl" SET "activeGenerationId"=${generations.one} WHERE "projectionName"='appointments'`;
  await assert.rejects(engine.activate(run),/REBUILD_POINTER_CHANGED/);
  await op.$executeRaw`UPDATE "ReadProjectionControl" SET "activeGenerationId"=${active} WHERE "projectionName"='appointments'`;
  await engine.abort(run);
  assert.equal((await generation(g)).state,'RETIRED');assert.equal((await control()).activeGenerationId,active);assert.equal(await activityMode(),'source');
  assert.ok(await db.appointmentDailySummary.count({where:{generation:g}})>0);
  assert.equal((await db.readRebuildRun.findUniqueOrThrow({where:{id:run}})).frozen,false);
  // V1 path stays row-only and version cannot be switched on resume.
  const v1run=randomUUID(),v1g=randomUUID();await engine.claim(v1run,v1g);
  await assert.rejects(engine.summarize(v1run),/REBUILD_SUMMARY_NOT_V2/);
  await assert.rejects(engine.claim(v1run,v1g,{schemaVersion:2}),/REBUILD_GENERATION_INVALID/);
  await engine.abort(v1run);assert.equal((await control()).activeGenerationId,active);
  await engine.close();mark('R04-R06-drift-pointer-abort');
});

test('R03/P10 after activation: old events replay as no-ops, new changes and tombstones move counters once',async()=>{
  const g=(await control()).activeGenerationId;assert.equal(g,generations.large);
  const id=randomUUID(),create=await write(id,{},{created:true});await projector().apply(create);
  const cancel=await write(id,{status:'cancelled'});await projector().apply(cancel);
  const tomb=await write(id,{},{deleted:true});await projector().apply(tomb);
  for(const raw of [create,cancel])await projector().apply(JSON.stringify({...JSON.parse(raw),eventId:randomUUID()}));
  assert.equal(await db.appointmentReadRow.count({where:{generation:g,appointmentId:id}}),0);
  // Replay every pre-rebuild outbox event against the new generation: no delta.
  const total=async()=>(await db.$queryRaw`SELECT sum("appointmentCount")::bigint AS n FROM "AppointmentDailySummary" WHERE generation=${g}`)[0].n;
  const before=await total();for(const e of await db.outboxEvent.findMany({take:50,orderBy:{createdAt:'asc'}}))await projector().apply(JSON.stringify(e.envelope));
  assert.equal(await total(),before);assert.deepEqual(await drift(g),{rows:0,source:0});mark('R03-P10-replay-after-rebuild');
});

test('F01-F04: evidence independent of list mode under reader role; drift, frozen run, broker loss and V1-only make summary ineligible',{timeout:120000},async()=>{
  const g=(await control()).activeGenerationId;process.env.BROKER_URL=broker;process.env.BROKER_PREFIX=prefix;
  const consumer=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector().apply(raw));
  try{
    const lane=new AuditLane(),listGuard=new ReadFreshness(audit,probeReadQueue),rows=new ReadFreshness(audit,probeReadQueue,undefined,undefined,{requireListProjection:false,perAggregateLag:true,lane});
    const summary=new ActivitySummaryEvidence(audit,rows,[1,2],lane);
    await listGuard.sample();assert.equal(listGuard.evidence,undefined);assert.equal((await control()).servingMode,'authoritative');
    await rows.sample();await summary.sample();
    assert.equal(rows.evidence?.schemaVersion,2,summary.failure);assert.equal(summary.ineligibleReason(g),undefined);
    timings.summaryAuditMs=summary.evidence.durationMs;assert.ok(summary.evidence.durationMs<1500);
    assert.equal(new ActivitySummaryEvidence(audit,rows,[1],lane).ineligibleReason(g),'capability_v1_only');
    const [k]=await db.$queryRaw`SELECT "appointmentDate"::text AS d,type::text AS t,status::text AS s FROM "AppointmentDailySummary" WHERE generation=${g} ORDER BY 1,2,3 LIMIT 1`;
    const nudge=n=>db.$executeRaw`UPDATE "AppointmentDailySummary" SET "appointmentCount"="appointmentCount"+${n} WHERE generation=${g} AND "appointmentDate"=CAST(${k.d} AS date) AND type=CAST(${k.t} AS "AppointmentType") AND status=CAST(${k.s} AS "AppointmentStatus")`;
    assert.equal(await nudge(1),1);
    await summary.sample();assert.equal(summary.ineligibleReason(g),'summary_drift');assert.equal(summary.evidence.driftBuckets,1);
    assert.equal(await nudge(-1),1);
    await summary.sample();assert.equal(summary.ineligibleReason(g),undefined);
    const run=randomUUID(),frozenDb=client(1),frozenEngine=new AppointmentRebuild(frozenDb);await frozenEngine.claim(run,randomUUID(),{schemaVersion:2});
    try{await summary.sample();await rows.sample();assert.equal(summary.ineligibleReason(g),'summary_frozen');}finally{await frozenEngine.abort(run);await frozenEngine.close();await frozenDb.$disconnect();}
    await summary.sample();await rows.sample();assert.equal(summary.ineligibleReason(g),undefined);
    await consumer.close();await rows.sample();assert.equal(summary.ineligibleReason(g),'rows_freshness_missing');
    mark('F01-F04-independent-evidence',{summaryAuditMs:timings.summaryAuditMs});
  }finally{await consumer.close().catch(()=>{});await waitForQueueIdle([routes.clinicRead]).catch(()=>{});}
});
