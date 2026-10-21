// D2 unit scope: pure contribution/delta/version semantics and projector control
// flow against an in-memory model. Atomicity, locks and concurrency are proven
// only by summary.integration.mjs on real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {contribution,summaryDeltas,compareSummaryKeys} from '../../../../services/clinic/dist/clinicActivitySummary.js';
import {projectionCapability,projectionInbox,assertProjectionTargets,capabilityReport,isProjectionVersion} from '../../../../services/clinic/dist/projectionVersions.js';
import {AppointmentProjector} from '../../../../services/clinic/dist/appointmentProjector.js';
import {activitySafeCount,buildActivityBusiness,parseActivityFilter} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {Prisma} from '../../../../services/clinic/src/generated/client/index.js';
import {runtimeGrantStatements} from '../../p7-cutover.mjs';
import {summaryModel,bucketId} from './summaryModel.mjs';

const day='2030-10-20',row=(more={})=>({appointmentDate:new Date(day+'T00:00:00Z'),type:'general_checkup',status:'pending',deletedAt:null,...more});
const key=(more={})=>({generation:'g',appointmentDate:day,type:'general_checkup',status:'pending',...more});

test('contribution: live row is one SQL-date/type/current-status bucket; deleted/missing is none',()=>{
  assert.deepEqual(contribution('g',row()),key());
  assert.equal(contribution('g',null),undefined);assert.equal(contribution('g',undefined),undefined);
  assert.equal(contribution('g',row({deletedAt:new Date()})),undefined);
  // Business date is the stored DATE, independent of host TZ or createdAt.
  assert.equal(contribution('g',row({appointmentDate:new Date('2028-02-29T00:00:00Z'),createdAt:new Date('2028-02-28T23:30:00Z')})).appointmentDate,'2028-02-29');
  for(const status of ['cancelled','no_show'])assert.equal(contribution('g',row({status})).status,status);
  assert.equal(contribution('g',row({type:'hotel_consultation'})).type,'hotel_consultation');
  for(const bad of [row({type:'pharmacy'}),row({status:'archived'})])assert.throws(()=>contribution('g',bad),/UNKNOWN_BUCKET/);
  assert.throws(()=>contribution('g',row({appointmentDate:new Date('invalid')})),/INVALID_DATE/);
});

test('deltas: old row -> latest source; transfers, no-ops and generation-first stable order',()=>{
  assert.deepEqual(summaryDeltas([{after:key()}]),[{key:key(),delta:1}]);
  assert.deepEqual(summaryDeltas([{before:key()}]),[{key:key(),delta:-1}]);
  // Note/billing/doctor change in the same bucket touches no counter.
  assert.deepEqual(summaryDeltas([{before:key(),after:key()}]),[]);assert.deepEqual(summaryDeltas([{}]),[]);
  const done=key({status:'completed'}),moved=key({appointmentDate:'2030-11-02'}),spa=key({type:'spa_bath'});
  assert.deepEqual(summaryDeltas([{before:key(),after:done}]),[{key:key(),delta:-1},{key:done,delta:1}]);
  assert.deepEqual(summaryDeltas([{before:key(),after:moved}]).map(d=>d.delta),[-1,1]);
  assert.deepEqual(summaryDeltas([{before:key(),after:spa}]).map(d=>d.key.type),['general_checkup','spa_bath']);
  // A->B and B->A lock the same buckets in the same order regardless of sign.
  const ab=summaryDeltas([{before:key(),after:done}]).map(d=>d.key),ba=summaryDeltas([{before:done,after:key()}]).map(d=>d.key);
  assert.deepEqual(ab,ba);
  const mixed=summaryDeltas([{before:key({generation:'h'}),after:key({generation:'h',status:'confirmed'})},{before:key(),after:key({status:'confirmed'})}]);
  assert.deepEqual(mixed.map(d=>d.key.generation),['g','g','h','h']);
  for(let i=1;i<mixed.length;i++)assert.ok(compareSummaryKeys(mixed[i-1].key,mixed[i].key)<0);
  // Status order is the enum order, not alphabetical (pending before cancelled).
  assert.ok(compareSummaryKeys(key(),key({status:'cancelled'}))<0);
});

test('projection versions: V1/V2 namespaces, explicit V1-only capability, unknown versions fail closed',()=>{
  assert.equal(projectionInbox({id:'g',schemaVersion:1}),'clinic-read-v1:g');
  assert.equal(projectionInbox({id:'g',schemaVersion:2}),'clinic-read-v2:g');
  assert.throws(()=>projectionInbox({id:'g',schemaVersion:3}),/UNSUPPORTED/);
  assert.deepEqual(projectionCapability(undefined),[1,2]);assert.deepEqual(projectionCapability('1,2'),[1,2]);assert.deepEqual(projectionCapability('1'),[1]);
  for(const raw of ['2','1, 2','v1','','1,2,3'])assert.throws(()=>projectionCapability(raw),/INVALID_CLINIC_READ_PROJECTION_VERSIONS/);
  assert.deepEqual(capabilityReport([1]),{projectionVersions:[1],summaryEnabled:false});assert.deepEqual(capabilityReport([1,2]),{projectionVersions:[1,2],summaryEnabled:true});
  assertProjectionTargets([1],[{schemaVersion:1}]);assertProjectionTargets([1,2],[{schemaVersion:1},{schemaVersion:2}]);
  assert.throws(()=>assertProjectionTargets([1],[{schemaVersion:1},{schemaVersion:2}]),/CAPABILITY_MISMATCH/);
  assert.throws(()=>assertProjectionTargets([1,2],[{schemaVersion:3}]),/CAPABILITY_MISMATCH/);
  assert.equal(isProjectionVersion(2),true);assert.equal(isProjectionVersion('2'),false);
});

test('model: create/status/date/type transfers keep rows<->summary exact; V1 stays row-only',async()=>{
  const m=summaryModel(),v1=m.generation(1,'ACTIVE','a-v1'),v2=m.generation(2,'BUILDING','b-v2'),p=new AppointmentProjector(m.db),id=randomUUID();
  assert.equal(await p.apply(m.write(id)),true);
  assert.equal(m.count(v2,day,'general_checkup','pending'),1n);
  assert.equal([...m.state.summary.keys()].some(k=>k.startsWith(v1+'|')),false);
  assert.ok(m.state.rows.has(v1+'|'+id)&&m.state.rows.has(v2+'|'+id));
  assert.deepEqual([...m.state.inbox].map(k=>k.split('|')[0].split(':')[0]).sort(),['clinic-read-v1','clinic-read-v2']);
  await p.apply(m.write(id,{status:'completed'}));
  await p.apply(m.write(id,{appointmentDate:new Date('2030-11-02T00:00:00Z')}));
  await p.apply(m.write(id,{type:'spa_grooming'}));
  assert.equal(m.count(v2,day,'general_checkup','pending'),0n);assert.equal(m.count(v2,day,'general_checkup','completed'),0n);
  assert.equal(m.count(v2,'2030-11-02','spa_grooming','completed'),1n);assert.equal(m.reconcile(v2),0);
});

test('model: duplicate x10, second event ID at same version and note/billing changes do not count twice',async()=>{
  const m=summaryModel(),g=m.generation(2),p=new AppointmentProjector(m.db),id=randomUUID(),raw=m.write(id);
  for(let i=0;i<10;i++)await p.apply(raw);
  assert.equal(p.stats.applied,1);assert.equal(p.stats.duplicates,9);assert.equal(m.count(g,day,'general_checkup','pending'),1n);
  const same=JSON.parse(raw);same.eventId=randomUUID();same.correlationId=same.eventId;
  assert.equal(await p.apply(JSON.stringify(same)),true);assert.equal(m.count(g,day,'general_checkup','pending'),1n);
  const before=p.stats.summaryBuckets;m.ops.length=0;
  await p.apply(m.write(id,{ownerNote:'changed',internalNote:'private',doctorId:'d',reservations:[{state:'HELD'}]}));
  assert.equal(p.stats.summaryBuckets,before);assert.equal(m.ops.some(o=>o.op==='increment'||o.op==='decrement'),false);
  assert.equal(m.state.rows.get(g+'|'+id).sourceVersion,2);assert.equal(m.state.rows.get(g+'|'+id).billingHeld,true);
  assert.equal(m.count(g,day,'general_checkup','pending'),1n);assert.equal(m.reconcile(g),0);
});

test('model: out-of-order 5,3,4,2 hydrates latest source v7 once; tombstone never resurrects',async()=>{
  const m=summaryModel(),g=m.generation(2),p=new AppointmentProjector(m.db),id=randomUUID(),events=[m.write(id)];
  for(const status of ['confirmed','checked_in','in_progress','completed','cancelled','no_show'])events.push(m.write(id,{status}));
  for(const v of [5,3,4,2])await p.apply(events[v-1]);
  assert.equal(m.state.rows.get(g+'|'+id).sourceVersion,7);assert.equal(m.count(g,day,'general_checkup','no_show'),1n);
  assert.equal(m.count(g,day,'general_checkup','pending')??0n,0n);assert.equal(m.reconcile(g),0);
  for(const v of [1,7,6])await p.apply(events[v-1]);
  assert.equal(m.count(g,day,'general_checkup','no_show'),1n);
  const deleted=m.write(id,{}, {deleted:true});await p.apply(deleted);
  assert.equal(m.count(g,day,'general_checkup','no_show'),0n);assert.equal(m.state.rows.has(g+'|'+id),false);
  // Old upsert notifications after the tombstone are no-ops, never +1 again.
  for(const old of events)await p.apply(JSON.stringify({...JSON.parse(old),eventId:randomUUID()}));
  assert.equal(m.count(g,day,'general_checkup','no_show'),0n);assert.equal(m.state.rows.has(g+'|'+id),false);
});

test('model: summary buckets are locked sorted before row writes; inbox precedes both',async()=>{
  const m=summaryModel(),g=m.generation(2),p=new AppointmentProjector(m.db),id=randomUUID();
  await p.apply(m.write(id,{status:'completed'}));m.ops.length=0;
  await p.apply(m.write(id,{status:'confirmed'}));
  // confirmed precedes completed in enum order, so completed->confirmed increments
  // first and confirmed->completed decrements first: same bucket lock order.
  const locked=()=>m.ops.filter(o=>o.op==='increment'||o.op==='decrement').map(o=>o.id.split('|')[3]);
  assert.deepEqual(m.ops.filter(o=>o.op!=='query').map(o=>o.op),['inbox','increment','decrement','row-upsert']);
  const first=locked();m.ops.length=0;await p.apply(m.write(id,{status:'completed'}));
  assert.deepEqual(m.ops.filter(o=>o.op!=='query').map(o=>o.op),['inbox','decrement','increment','row-upsert']);
  assert.deepEqual(locked(),first);assert.deepEqual(first,['confirmed','completed']);
  assert.equal(m.reconcile(g),0);
});

test('model: failpoints after inbox/decrement/increment/row roll back everything; replay applies once',async()=>{
  for(const stage of ['inbox-written','summary-decremented','summary-incremented','row-written']){
    const m=summaryModel(),g=m.generation(2),id=randomUUID();
    await new AppointmentProjector(m.db).apply(m.write(id));
    const raw=m.write(id,{status:'cancelled'}),before=structuredClone(m.state);
    await assert.rejects(new AppointmentProjector(m.db,async s=>{if(s===stage)throw new Error('FAILPOINT_'+stage);}).apply(raw),new RegExp('FAILPOINT_'+stage));
    assert.deepEqual(m.state.summary,before.summary,stage);assert.deepEqual(m.state.inbox,before.inbox,stage);assert.deepEqual(m.state.rows,before.rows,stage);
    const p=new AppointmentProjector(m.db);assert.equal(await p.apply(raw),true);assert.equal(await p.apply(raw),false);
    assert.equal(m.count(g,day,'general_checkup','cancelled'),1n);assert.equal(m.count(g,day,'general_checkup','pending'),0n);assert.equal(m.reconcile(g),0);
  }
});

test('model: missing/underflow bucket, projection ahead and V1-only binary on V2 fail without ACK-able commit',async()=>{
  const m=summaryModel(),g=m.generation(2),p=new AppointmentProjector(m.db),id=randomUUID();
  await p.apply(m.write(id));
  m.state.summary.delete(bucketId(g,day,'general_checkup','pending'));
  const raw=m.write(id,{status:'confirmed'}),inbox=m.state.inbox.size;
  await assert.rejects(p.apply(raw),/READ_SUMMARY_BUCKET_MISSING/);assert.equal(m.state.inbox.size,inbox);
  m.state.summary.set(bucketId(g,day,'general_checkup','pending'),0n);
  await assert.rejects(p.apply(raw),/READ_SUMMARY_COUNTER_UNDERFLOW/);assert.equal(m.count(g,day,'general_checkup','confirmed'),undefined);
  m.state.summary.set(bucketId(g,day,'general_checkup','pending'),1n);await p.apply(raw);assert.equal(m.reconcile(g),0);
  m.state.rows.get(g+'|'+id).sourceVersion=99;
  await assert.rejects(p.apply(m.write(id,{status:'completed'})),/AHEAD_OF_SOURCE/);
  const v=summaryModel();v.generation(1,'ACTIVE','a');v.generation(2,'BUILDING','b');
  const v1only=new AppointmentProjector(v.db,undefined,[1]);
  await assert.rejects(v1only.apply(v.write(randomUUID())),/CAPABILITY_MISMATCH/);
  assert.equal(v.state.inbox.size,0);assert.equal(v.state.rows.size,0);
  const l=summaryModel(),lg=l.generation(1);await new AppointmentProjector(l.db,undefined,[1]).apply(l.write(randomUUID()));
  assert.equal(l.state.rows.size,1);assert.equal(l.state.summary.size,0);assert.ok([...l.state.inbox][0].startsWith('clinic-read-v1:'+lg));
});

test('BigInt: summary counters serialize only as checked safe integers, totals included',()=>{
  assert.equal(activitySafeCount(BigInt(Number.MAX_SAFE_INTEGER)),Number.MAX_SAFE_INTEGER);
  assert.throws(()=>activitySafeCount(BigInt(Number.MAX_SAFE_INTEGER)+1n),e=>e.status===503);
  assert.throws(()=>activitySafeCount(-1n),e=>e.status===503);
  const filter=parseActivityFilter({from:day,to:day}),half=BigInt(Number.MAX_SAFE_INTEGER)/2n+1n;
  // Two safe buckets whose sum is unsafe must fail, never round through Number().
  assert.throws(()=>buildActivityBusiness(filter,[{date:day,type:'general_checkup',status:'pending',n:half},{date:day,type:'general_checkup',status:'confirmed',n:half}]),e=>e.status===503);
  const ok=buildActivityBusiness(filter,[{date:day,type:'general_checkup',status:'pending',n:2n}]);assert.equal(JSON.parse(JSON.stringify(ok)).current.total,2);
});

test('schema: additive V2 summary/control with CHECK, composite V2 FK RESTRICT, fence and immutable version',()=>{
  const sql=readFileSync('services/clinic/prisma/migrations/20261021000100_appointment_daily_summary_v2/migration.sql','utf8');
  for(const forbidden of [/\bDROP\b/i,/\bTRUNCATE\s+"/i,/ALTER\s+COLUMN/i,/\bRENAME\b/i,/\bDELETE\s+FROM\b/i,/\bUPDATE\s+"/i,/\bGRANT\b/i])assert.doesNotMatch(sql,forbidden);
  for(const required of ['PRIMARY KEY ("generation","appointmentDate","type","status")','CHECK ("appointmentCount" >= 0)','CHECK ("schemaVersion" = 2)',
    'FOREIGN KEY ("generation","schemaVersion") REFERENCES "ReadProjectionGeneration"("id","schemaVersion") ON DELETE RESTRICT ON UPDATE RESTRICT',
    `CHECK ("servingMode" IN ('source','cached','summary'))`,`VALUES (1,'source')`,'CHECK ("id" = 1)','CHECK ("schemaVersion" IN (1,2))',
    'BEFORE UPDATE OF "schemaVersion" ON "ReadProjectionGeneration"','ON "AppointmentDailySummary" FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence()',
    'ON "ClinicActivityControl" FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence()'])assert.ok(sql.includes(required),required);
  assert.doesNotMatch(sql.split('CREATE TABLE "AppointmentDailySummary"')[1].split(');')[0],/owner|note|billing|pet|doctor/i);
  const models=Object.fromEntries(Prisma.dmmf.datamodel.models.map(m=>[m.name,m]));
  assert.deepEqual(models.AppointmentDailySummary.primaryKey.fields,['generation','appointmentDate','type','status']);
  assert.equal(models.AppointmentDailySummary.fields.find(f=>f.name==='appointmentCount').type,'BigInt');
  assert.deepEqual(models.ClinicActivityControl.fields.filter(f=>f.kind!=='object').map(f=>f.name),['id','servingMode','updatedAt']);
  assert.equal(models.ClinicActivityControl.fields.some(f=>/generation/i.test(f.name)),false);
});

test('grants: runtime may read summary/control and upsert counters; never delete counters or change activity mode',()=>{
  const write=runtimeGrantStatements('clinic','"r"',true),read=runtimeGrantStatements('clinic','"r"',false);
  const select=write.find(s=>s.startsWith('GRANT SELECT'));
  for(const t of ['AppointmentDailySummary','ClinicActivityControl'])assert.ok(select.includes('runtime."'+t+'"'),t);
  assert.deepEqual(read.filter(s=>s.startsWith('GRANT')),[read.find(s=>s.startsWith('GRANT SELECT'))]);
  const dml=write.find(s=>s.startsWith('GRANT INSERT,UPDATE,DELETE'));
  for(const t of ['AppointmentDailySummary','ClinicActivityControl','ReadProjectionGeneration','ReadProjectionControl','ReadRebuildRun','ClinicReadRevision'])assert.ok(!dml.includes('"'+t+'"'),t);
  assert.ok(dml.includes('runtime."AppointmentReadRow"')&&dml.includes('runtime."InboxEvent"'));
  assert.ok(write.includes('GRANT INSERT,UPDATE ON runtime."AppointmentDailySummary" TO "r"'));
  assert.equal(write.filter(s=>s.includes('ClinicActivityControl')&&!s.startsWith('GRANT SELECT')&&!s.startsWith('REVOKE')).length,0);
});

test('sources: no hardcoded projection V1 left in projector/worker/readers; events stay envelope v1',()=>{
  for(const file of ['appointmentProjector','readWorker','readFreshness','infrastructure/queries/servingAppointments','infrastructure/queries/shadowAppointments']){
    const source=readFileSync('services/clinic/src/'+file+'.ts','utf8');assert.doesNotMatch(source,/schemaVersion(:|!==|===)\s*1\b/,file);
  }
  assert.match(readFileSync('services/clinic/src/readRevision.ts','utf8'),/schemaVersion:1,producer:'clinic'/);
  // D3: rebuild targets V1 or V2 by explicit parameter; existing callers default to V1.
  const rebuild=readFileSync('services/clinic/src/readRebuild.ts','utf8');
  assert.doesNotMatch(rebuild,/schemaVersion(!==|===)\s*1\b/);assert.match(rebuild,/schemaVersion=1 as ProjectionVersion/);
});
