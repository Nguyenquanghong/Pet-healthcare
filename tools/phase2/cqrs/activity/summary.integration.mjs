// D2 real-PostgreSQL cases P01-P12 for row+summary+inbox. Only launched by
// run-summary-projector.mjs on a freshly migrated, marked UUID schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertTestProject} from '../../test-project.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {recordAppointmentChange,initializeAppointmentProjection} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentProjector} from '../../../../services/clinic/dist/appointmentProjector.js';
import {reconcileProjection} from '../../../../services/clinic/dist/projectionSnapshot.js';
import {activitySafeCount} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';

assertTestProject();
const contextPath=resolve(process.env.ACTIVITY_D2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs/activity')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8')),hex=c.run.replaceAll('-','');
assert.match(c.run,/^[0-9a-f-]{36}$/);assert.equal(c.schema,'activity_d2_'+hex);assert.equal(c.marker,'clinic-activity-d2:'+c.run);
assert.deepEqual(c.roles,{projector:'act_d2_p_'+hex,reader:'act_d2_r_'+hex});
const client=(limit=4)=>{const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit',String(limit));return new PrismaClient({datasourceUrl:url.href});};
// Owner client = source writer/fixture/assertions. Workers run every projector
// transaction under SET LOCAL ROLE of the restricted projector role.
const db=client(6),workerA=client(4),workerB=client(4),v1=randomUUID(),v2=randomUUID(),results=[];
const asRole=(base,role)=>new Proxy(base,{get(t,k){if(k==='$transaction')return (work,options)=>t.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);return work(tx);},options);const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
const A=asRole(workerA,c.roles.projector),B=asRole(workerB,c.roles.projector);
const projector=(base=A,onStage,capability)=>new AppointmentProjector(base,onStage,capability);
const mark=name=>{results.push({name,status:'PASS'});writeFileSync(resolve(c.output,'cases.json'),JSON.stringify({run:c.run,schema:c.schema,generations:{v1,v2},results},null,2));};
const pgCode=code=>e=>e?.meta?.code===code||String(e?.message).includes(code);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let dayIndex=0;const nextDay=()=>new Date(Date.UTC(2030,9,1+dayIndex++)).toISOString().slice(0,10);

async function write(id,patch={},{created=false,deleted=false}={}){
  return db.$transaction(async tx=>{
    if(created)await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:'general_checkup',serviceName:'D2 fixture',clinicName:'Fixture',appointmentDate:new Date(nextDay()),appointmentTime:'09:00',...patch}});
    else{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;
      if(deleted){await tx.appointmentReservation.deleteMany({where:{appointmentId:id}});await tx.appointment.delete({where:{id}});}
      else if(Object.keys(patch).length)await tx.appointment.update({where:{id},data:patch});}
    const {eventId}=await recordAppointmentChange(tx,id,{created,deleted});
    return JSON.stringify((await tx.outboxEvent.findUniqueOrThrow({where:{id:eventId}})).envelope);
  },{timeout:15000});
}
const create=patch=>{const id=randomUUID();return write(id,patch,{created:true}).then(raw=>({id,raw}));};
const reissue=raw=>{const e=JSON.parse(raw);e.eventId=randomUUID();return JSON.stringify(e);};
const iso=d=>d.toISOString().slice(0,10);
async function bucket(g,date,type,status){const [r]=await db.$queryRaw`SELECT "appointmentCount" AS n,xmin::text AS xmin FROM "AppointmentDailySummary" WHERE generation=${g} AND "appointmentDate"=CAST(${date} AS date) AND type=CAST(${type} AS "AppointmentType") AND status=CAST(${status} AS "AppointmentStatus")`;return r;}
const count=async(...k)=>(await bucket(...k))?.n??0n;
// rows<->summary per bucket (zero normalized) and, when caught up, source<->summary.
async function diffs(g=v2){
  const [r]=await db.$queryRaw`WITH m AS (SELECT "appointmentDate" d,type t,status s,"appointmentCount" n FROM "AppointmentDailySummary" WHERE generation=${g} AND "appointmentCount"<>0),
    r AS (SELECT "appointmentDate" d,type t,status s,count(*)::bigint n FROM "AppointmentReadRow" WHERE generation=${g} AND "deletedAt" IS NULL GROUP BY 1,2,3),
    s AS (SELECT appointment_date d,type t,status s,count(*)::bigint n FROM appointments GROUP BY 1,2,3)
    SELECT (SELECT count(*) FROM r FULL JOIN m USING (d,t,s) WHERE r.n IS DISTINCT FROM m.n)::int AS rows,
      (SELECT count(*) FROM s FULL JOIN m USING (d,t,s) WHERE s.n IS DISTINCT FROM m.n)::int AS source`;
  return r;
}
async function state(id,eventId){
  const summary=await db.$queryRaw`SELECT generation,"appointmentDate"::text AS d,type::text AS t,status::text AS s,"appointmentCount" AS n FROM "AppointmentDailySummary" ORDER BY 1,2,3,4`;
  const rows=await db.$queryRaw`SELECT generation,"sourceVersion",status::text AS status,"appointmentDate"::text AS d FROM "AppointmentReadRow" WHERE "appointmentId"=${id} ORDER BY generation`;
  const inbox=await db.$queryRaw`SELECT "consumerName" FROM "InboxEvent" WHERE "eventId"=${eventId} ORDER BY 1`;
  return {summary,rows,inbox};
}

test.before(async()=>{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  for(const w of [A,B])assert.deepEqual(await w.$transaction(tx=>tx.$queryRaw`SELECT current_user AS role`),[{role:c.roles.projector}]);
  // Fixture generations, not a D3 rebuild: empty source, V1 via initial adoption,
  // then a separate new-UUID V2 BUILDING target. Lists stay authoritative.
  await initializeAppointmentProjection(db,v1);
  await db.readProjectionGeneration.create({data:{id:v2,schemaVersion:2}});
});
test.after(async()=>{await Promise.all([db,workerA,workerB].map(x=>x.$disconnect()));});

test('migration: constraints, V2-only FK, immutable version, singleton default source control',async()=>{
  assert.deepEqual((await db.clinicActivityControl.findMany()).map(r=>[r.id,r.servingMode]),[[1,'source']]);
  await assert.rejects(db.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"appointmentCount") VALUES (${v1},'2030-01-01','other','pending',1)`,pgCode('23503'));
  await assert.rejects(db.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"schemaVersion","appointmentCount") VALUES (${v1},'2030-01-01','other','pending',1,1)`,pgCode('23514'));
  await assert.rejects(db.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"appointmentCount") VALUES (${v2},'2030-01-01','other','pending',-1)`,pgCode('23514'));
  await assert.rejects(db.$executeRaw`UPDATE "ReadProjectionGeneration" SET "schemaVersion"=2 WHERE id=${v1}`,pgCode('READ_PROJECTION_SCHEMA_VERSION_IMMUTABLE'));
  await assert.rejects(db.$executeRaw`INSERT INTO "ReadProjectionGeneration" (id,"schemaVersion") VALUES (${randomUUID()},3)`,pgCode('23514'));
  await assert.rejects(db.$executeRaw`INSERT INTO "ClinicActivityControl" (id) VALUES (2)`,pgCode('23514'));
  await assert.rejects(db.$executeRaw`UPDATE "ClinicActivityControl" SET "servingMode"='projection'`,pgCode('23514'));
  assert.equal((await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).servingMode,'authoritative');
  mark('migration-constraints');
});

test('grants: projector upserts counters but cannot delete them or change modes; reader is SELECT-only',async()=>{
  const can=async(role,table,privilege)=>(await db.$queryRawUnsafe(`SELECT has_table_privilege($1,'"${c.schema}"."${table}"',$2) AS ok`,role,privilege))[0].ok;
  for(const [table,privilege,expected] of [['AppointmentDailySummary','SELECT',true],['AppointmentDailySummary','INSERT',true],['AppointmentDailySummary','UPDATE',true],['AppointmentDailySummary','DELETE',false],
    ['ClinicActivityControl','SELECT',true],['ClinicActivityControl','UPDATE',false],['ReadProjectionGeneration','UPDATE',false],['ReadProjectionControl','UPDATE',false]])assert.equal(await can(c.roles.projector,table,privilege),expected,table+privilege);
  for(const table of ['AppointmentDailySummary','ClinicActivityControl']){assert.equal(await can(c.roles.reader,table,'SELECT'),true);for(const p of ['INSERT','UPDATE','DELETE'])assert.equal(await can(c.roles.reader,table,p),false,table+p);}
  const reader=asRole(workerA,c.roles.reader);
  await assert.rejects(reader.$transaction(tx=>tx.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status) VALUES (${v2},'2030-01-02','other','pending')`),pgCode('42501'));
  await assert.rejects(A.$transaction(tx=>tx.$executeRaw`DELETE FROM "AppointmentDailySummary"`),pgCode('42501'));
  await assert.rejects(A.$transaction(tx=>tx.$executeRaw`UPDATE "ClinicActivityControl" SET "servingMode"='summary'`),pgCode('42501'));
  mark('role-grants');
});

test('P01/A07: create, status, reschedule and type change move exactly one contribution',async()=>{
  const {id,raw}=await create(),p=projector();assert.equal(await p.apply(raw),true);
  const a=await db.appointment.findUniqueOrThrow({where:{id}}),d=iso(a.appointmentDate),later=nextDay();
  assert.equal(await count(v2,d,'general_checkup','pending'),1n);
  assert.equal((await db.appointmentReadRow.count({where:{appointmentId:id}})),2);
  await p.apply(await write(id,{status:'cancelled'}));await p.apply(await write(id,{status:'pending'}));// undo reflects current state
  await p.apply(await write(id,{appointmentDate:new Date(later)}));await p.apply(await write(id,{type:'spa_combo',status:'no_show'}));
  assert.equal(await count(v2,d,'general_checkup','pending'),0n);assert.equal(await count(v2,d,'general_checkup','cancelled'),0n);
  assert.equal(await count(v2,later,'spa_combo','no_show'),1n);assert.deepEqual(await diffs(),{rows:0,source:0});
  mark('P01-transfer');
});

test('P02/P08: same event 10x and a second event ID at the same version never double count',async()=>{
  const {id,raw}=await create(),p=projector();const a=await db.appointment.findUniqueOrThrow({where:{id}}),d=iso(a.appointmentDate);
  const outcomes=[];for(let i=0;i<10;i++)outcomes.push(await (i%2?projector(B):p).apply(raw));
  assert.deepEqual(outcomes,[true,...Array(9).fill(false)]);
  assert.equal(await count(v2,d,'general_checkup','pending'),1n);
  const {xmin}=await bucket(v2,d,'general_checkup','pending');
  assert.equal(await p.apply(reissue(raw)),true);assert.equal((await bucket(v2,d,'general_checkup','pending')).xmin,xmin);
  assert.equal(await db.inboxEvent.count({where:{eventId:JSON.parse(raw).eventId}}),2);
  mark('P02-duplicates');
});

test('P03: out-of-order 5,3,4,2 hydrates latest source v7 and later replays are no-ops',async()=>{
  const {id,raw}=await create(),events=[raw];
  for(const status of ['confirmed','checked_in','in_progress','completed','cancelled','no_show'])events.push(await write(id,{status}));
  const p=projector();for(const v of [5,3,4,2])await p.apply(events[v-1]);
  const a=await db.appointment.findUniqueOrThrow({where:{id}}),d=iso(a.appointmentDate);
  assert.equal((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation:v2,appointmentId:id}}})).sourceVersion,7);
  assert.equal(await count(v2,d,'general_checkup','no_show'),1n);
  for(const v of [1,7,6])await p.apply(events[v-1]);
  assert.equal(await count(v2,d,'general_checkup','no_show'),1n);assert.deepEqual(await diffs(),{rows:0,source:0});
  mark('P03-out-of-order');
});

test('A08: note, doctor and billing changes update row/version but never touch the counter',async()=>{
  const {id,raw}=await create(),p=projector();await p.apply(raw);
  const a=await db.appointment.findUniqueOrThrow({where:{id}}),d=iso(a.appointmentDate),{xmin}=await bucket(v2,d,'general_checkup','pending');
  await p.apply(await write(id,{ownerNote:'changed',internalNote:'D2_PRIVATE',doctorId:randomUUID()}));
  await db.appointmentReservation.create({data:{operationId:randomUUID(),appointmentId:id,revisionAtPrepare:1,snapshot:{fixture:true}}});
  const before=p.stats.summaryBuckets;await p.apply(await write(id));
  const row=await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation:v2,appointmentId:id}}});
  assert.equal(row.sourceVersion,3);assert.equal(row.billingHeld,true);assert.equal(row.ownerNote,'changed');
  assert.equal(p.stats.summaryBuckets,before);assert.equal((await bucket(v2,d,'general_checkup','pending')).xmin,xmin);
  mark('A08-no-counter-write');
});

test('P04: two workers on one appointment serialize on the registry lock without lost updates',async()=>{
  const {id,raw}=await create(),events=[raw];
  for(const status of ['confirmed','checked_in','in_progress','completed'])events.push(await write(id,{status}));
  const locked=deferred(),release=deferred();
  const first=projector(A,async s=>{if(s==='registry-locked'){locked.resolve();await release.promise;}}).apply(events[1]);
  await locked.promise;const second=projector(B).apply(events[4]);
  await waitFor(async()=>(await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%ClinicReadRevision%'`)[0].n>0);
  release.resolve();assert.deepEqual(await Promise.all([first,second]),[true,true]);
  await Promise.all(events.map((e,i)=>projector(i%2?A:B).apply(e)));
  const a=await db.appointment.findUniqueOrThrow({where:{id}});
  assert.equal(await count(v2,iso(a.appointmentDate),'general_checkup','completed'),1n);assert.deepEqual(await diffs(),{rows:0,source:0});
  mark('P04-same-appointment');
});

test('P05: 100 appointments contend on one hot bucket; counts are exact',async()=>{
  const date=nextDay(),items=[];for(let i=0;i<100;i++)items.push(await create({appointmentDate:new Date(date),type:'vaccination'}));
  for(let i=0;i<items.length;i+=8)await Promise.all(items.slice(i,i+8).map((x,j)=>projector(j%2?A:B).apply(x.raw)));
  assert.equal(await count(v2,date,'vaccination','pending'),100n);
  const moves=[];for(const x of items)moves.push(await write(x.id,{status:'confirmed'}));
  for(let i=0;i<moves.length;i+=8)await Promise.all(moves.slice(i,i+8).map((raw,j)=>projector(j%2?A:B).apply(raw)));
  assert.equal(await count(v2,date,'vaccination','pending'),0n);assert.equal(await count(v2,date,'vaccination','confirmed'),100n);
  assert.deepEqual(await diffs(),{rows:0,source:0});mark('P05-hot-bucket');
});

test('P06: reverse bucket transfers under a barrier commit without deadlock; unsorted control deadlocks',async()=>{
  // Control: two raw transactions locking k1->k2 and k2->k1 do deadlock in this PG.
  const date=nextDay();for(const status of ['pending','confirmed'])await db.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"appointmentCount") VALUES (${v2},CAST(${date} AS date),'dental',CAST(${status} AS "AppointmentStatus"),0)`;
  const both=deferred();let n=0;const lock=(tx,s)=>tx.$executeRaw`UPDATE "AppointmentDailySummary" SET "appointmentCount"="appointmentCount" WHERE generation=${v2} AND "appointmentDate"=CAST(${date} AS date) AND type='dental' AND status=CAST(${s} AS "AppointmentStatus")`;
  const control=await Promise.allSettled([['pending','confirmed'],['confirmed','pending']].map(([x,y],i)=>(i?workerB:workerA).$transaction(async tx=>{await lock(tx,x);if(++n===2)both.resolve();await both.promise;await lock(tx,y);},{timeout:15000})));
  assert.equal(control.filter(r=>r.status==='rejected'&&pgCode('40P01')(r.reason)).length,1);
  const pairs=[];for(let i=0;i<20;i++){const d=nextDay();pairs.push({d,x:await create({appointmentDate:new Date(d),type:'surgery'}),y:await create({appointmentDate:new Date(d),type:'surgery',status:'completed'})});}
  for(const p of pairs)await Promise.all([projector().apply(p.x.raw),projector(B).apply(p.y.raw)]);
  let deadlocks=0;
  for(const p of pairs){
    const xr=await write(p.x.id,{status:'completed'}),yr=await write(p.y.id,{status:'pending'}),gate=deferred();let ready=0;
    const hold=async s=>{if(s==='source-read'){if(++ready===2)gate.resolve();await gate.promise;}};
    const r=await Promise.allSettled([projector(A,hold).apply(xr),projector(B,hold).apply(yr)]);
    deadlocks+=r.filter(x=>x.status==='rejected'&&pgCode('40P01')(x.reason)).length;
    assert.deepEqual(r.map(x=>x.status),['fulfilled','fulfilled']);
    assert.equal(await count(v2,p.d,'surgery','pending'),1n);assert.equal(await count(v2,p.d,'surgery','completed'),1n);
  }
  assert.equal(deadlocks,0);assert.deepEqual(await diffs(),{rows:0,source:0});mark('P06-reverse-transfer');
});

test('P07: failpoints after inbox, decrement, increment and row write roll back row+summary+inbox',async()=>{
  for(const stage of ['inbox-written','summary-decremented','summary-incremented','row-written']){
    const {id,raw}=await create();await projector().apply(raw);
    const next=await write(id,{status:'checked_in'}),eventId=JSON.parse(next).eventId,before=await state(id,eventId);
    await assert.rejects(projector(A,async s=>{if(s===stage)throw new Error('D2_FAILPOINT');}).apply(next),/D2_FAILPOINT/);
    assert.deepEqual(await state(id,eventId),before,stage);
    assert.equal(await projector(B).apply(next),true);assert.equal(await projector().apply(next),false);
    const a=await db.appointment.findUniqueOrThrow({where:{id}});
    assert.equal(await count(v2,iso(a.appointmentDate),'general_checkup','checked_in'),1n,stage);
    assert.equal(await db.inboxEvent.count({where:{eventId}}),2);
  }
  assert.deepEqual(await diffs(),{rows:0,source:0});mark('P07-failpoints');
});

test('P09: missing/underflow bucket, projection ahead and registry mismatch fail; nothing is clamped',async()=>{
  const {id,raw}=await create();await projector().apply(raw);
  const a=await db.appointment.findUniqueOrThrow({where:{id}}),d=iso(a.appointmentDate),next=await write(id,{status:'confirmed'}),eventId=JSON.parse(next).eventId;
  await db.$executeRaw`DELETE FROM "AppointmentDailySummary" WHERE generation=${v2} AND "appointmentDate"=CAST(${d} AS date) AND type='general_checkup' AND status='pending'`;
  await assert.rejects(projector().apply(next),/READ_SUMMARY_BUCKET_MISSING/);assert.equal(await db.inboxEvent.count({where:{eventId}}),0);
  await db.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"appointmentCount") VALUES (${v2},CAST(${d} AS date),'general_checkup','pending',0)`;
  await assert.rejects(projector().apply(next),/READ_SUMMARY_COUNTER_UNDERFLOW/);assert.equal(await count(v2,d,'general_checkup','pending'),0n);
  await db.$executeRaw`UPDATE "AppointmentDailySummary" SET "appointmentCount"=1 WHERE generation=${v2} AND "appointmentDate"=CAST(${d} AS date) AND type='general_checkup' AND status='pending'`;
  assert.equal(await projector().apply(next),true);
  await db.appointmentReadRow.update({where:{generation_appointmentId:{generation:v2,appointmentId:id}},data:{sourceVersion:99}});
  await assert.rejects(projector().apply(await write(id,{status:'completed'})),/AHEAD_OF_SOURCE/);
  await db.appointmentReadRow.update({where:{generation_appointmentId:{generation:v2,appointmentId:id}},data:{sourceVersion:2}});
  await projector().apply(await write(id));
  const orphan=await create();await db.appointment.delete({where:{id:orphan.id}});
  await assert.rejects(projector().apply(orphan.raw),/READ_SOURCE_REGISTRY_MISMATCH/);
  await db.$transaction(async tx=>{await recordAppointmentChange(tx,orphan.id,{deleted:true});});
  assert.deepEqual(await diffs(),{rows:0,source:0});mark('P09-invalid-state');
});

test('P10: tombstone removes one contribution; older upserts never resurrect it',async()=>{
  const {id,raw}=await create(),events=[raw,await write(id,{status:'confirmed'})],p=projector();
  for(const e of events)await p.apply(e);
  const a=await db.appointment.findUniqueOrThrow({where:{id}}),d=iso(a.appointmentDate);
  await p.apply(await write(id,{},{deleted:true}));
  assert.equal(await count(v2,d,'general_checkup','confirmed'),0n);assert.equal(await db.appointmentReadRow.count({where:{appointmentId:id}}),0);
  for(const e of events)await p.apply(reissue(e));
  assert.equal(await count(v2,d,'general_checkup','confirmed'),0n);assert.equal(await db.appointmentReadRow.count({where:{appointmentId:id}}),0);
  assert.deepEqual(await diffs(),{rows:0,source:0});mark('P10-tombstone');
});

test('P12: counters are PostgreSQL BigInt and unsafe values never serialize',async()=>{
  const date=nextDay(),unsafe=2n**53n;
  await db.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"appointmentCount") VALUES (${v2},CAST(${date} AS date),'other','completed',${unsafe})`;
  const n=await count(v2,date,'other','completed');assert.equal(typeof n,'bigint');assert.equal(n,unsafe);
  assert.throws(()=>activitySafeCount(n),e=>e.status===503);assert.equal(activitySafeCount(n-1n),Number.MAX_SAFE_INTEGER);
  await db.$executeRaw`DELETE FROM "AppointmentDailySummary" WHERE generation=${v2} AND "appointmentDate"=CAST(${date} AS date) AND type='other'`;
  mark('P12-bigint');
});

test('P11: V1 stays row-only and reconciled; V1-only binary refuses V2 targets, then runs a V1-only schema',async()=>{
  assert.equal(await db.appointmentDailySummary.count({where:{generation:v1}}),0);
  for(const g of [v1,v2])assert.deepEqual(Object.values(await db.$transaction(tx=>reconcileProjection(tx,g))).filter(Boolean),[],g);
  const {id,raw}=await create(),eventId=JSON.parse(raw).eventId;
  await assert.rejects(projector(A,undefined,[1]).apply(raw),/READ_PROJECTION_CAPABILITY_MISMATCH/);
  assert.equal(await db.inboxEvent.count({where:{eventId}}),0);assert.equal(await db.appointmentReadRow.count({where:{appointmentId:id}}),0);
  await projector().apply(raw);
  // L-like composition in this disposable schema only: retire V2, V1-only binary maintains rows.
  await db.readProjectionGeneration.update({where:{id:v2},data:{state:'RETIRED'}});
  const before=await db.$queryRaw`SELECT sum("appointmentCount")::text AS n FROM "AppointmentDailySummary"`;
  const next=await write(id,{status:'confirmed'});assert.equal(await projector(B,undefined,[1]).apply(next),true);
  assert.equal((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation:v1,appointmentId:id}}})).status,'confirmed');
  assert.deepEqual(await db.$queryRaw`SELECT sum("appointmentCount")::text AS n FROM "AppointmentDailySummary"`,before);
  assert.deepEqual(await db.inboxEvent.findMany({where:{eventId:JSON.parse(next).eventId},select:{consumerName:true}}),[{consumerName:'clinic-read-v1:'+v1}]);
  assert.equal((await db.clinicActivityControl.findUniqueOrThrow({where:{id:1}})).servingMode,'source');
  assert.equal((await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).servingMode,'authoritative');
  mark('P11-version-compatibility');
});

async function waitFor(check,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw new Error('D2_WAIT_TIMEOUT');}
