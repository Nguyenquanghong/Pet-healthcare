import test from 'node:test';
import assert from 'node:assert/strict';
import {parseActivityFilter,buildActivityBusiness} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {activitySourceStatement,ClinicActivityQueries} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';
import {buildActivityFixture,activityFixtureStatuses,activityFixtureTypes} from './fixture.mjs';
import {activityPreset,activityDrilldown,readActivityDrilldown,validActivityFilters} from '../../../../frontend/src/services/clinicActivity.ts';
const filter=(more={})=>parseActivityFilter({from:'2030-09-21',to:'2030-10-20',...more});
const group=(date,status,n,type='general_checkup')=>({date,status,n:BigInt(n),type});
function database(rows=[],hook){
  const calls=[];
  const db={$transaction:async(work,options)=>{
    const setup=[];calls.push({options,setup});
    return work({$executeRawUnsafe:async sql=>setup.push(sql),$queryRaw:async sql=>{calls.at(-1).sql=sql;return hook?hook():structuredClone(rows);}});
  }};return {db,calls};
}
test('strict calendar parsing, adjacent equal periods and leap/year boundaries',()=>{
  assert.deepEqual(filter(),{from:'2030-09-21',to:'2030-10-20',previousFrom:'2030-08-22',previousTo:'2030-09-20',category:'all',groupBy:'day'});
  const leap=parseActivityFilter({from:'2028-02-29',to:'2028-03-01',groupBy:'month'});
  assert.equal(leap.previousFrom,'2028-02-27');assert.equal(leap.previousTo,'2028-02-28');
  for(const more of [{from:'2030-02-29'},{from:['2030-09-21']},{to:'2030-09-20'},{from:'2029-01-01'},
    {from:'1000-01-01',to:'1000-01-01'},{category:'medical'},{groupBy:'DAY'},{ownerId:'other'},{mode:'summary'},{from:' 2030-09-21'},{category:['all']}])
    assert.throws(()=>filter(more),e=>e.status===422,JSON.stringify(more));
});
test('current status/date rates, complete zero-filled enums, previous and clipped month buckets',()=>{
  const business=buildActivityBusiness(filter({groupBy:'month'}),[group('2030-09-20','completed',2),group('2030-09-21','cancelled',1),group('2030-10-20','no_show',1,'spa_combo'),group('2030-10-20','completed',2,'hotel_consultation')]);
  assert.equal(business.current.total,4);assert.equal(business.previous.total,2);
  assert.equal(business.current.cancellationRate,.25);assert.equal(business.current.noShowRate,.25);
  assert.deepEqual(business.comparison,{totalDelta:2,totalDeltaPercent:100});
  assert.deepEqual(Object.keys(business.current.byStatus),activityFixtureStatuses);
  assert.deepEqual(business.current.byType.map(x=>x.type),activityFixtureTypes);
  assert.deepEqual(business.current.buckets.map(b=>[b.from,b.to,b.total]),[['2030-09-21','2030-09-30',1],['2030-10-01','2030-10-20',3]]);
  const empty=buildActivityBusiness(filter(),[]);assert.equal(empty.current.buckets.length,30);
  assert.equal(empty.current.cancellationRate,null);assert.equal(empty.previous.noShowRate,null);assert.equal(empty.comparison.totalDeltaPercent,null);
  assert.ok(empty.current.buckets.every(b=>b.total===0));
});
test('unsafe totals and invalid groups fail instead of rounding, negative counters or dropped types',()=>{
  assert.throws(()=>buildActivityBusiness(filter(),[group('2030-10-20','completed',BigInt(Number.MAX_SAFE_INTEGER)),group('2030-10-20','pending',1)]),e=>e.status===503);
  assert.throws(()=>buildActivityBusiness(filter(),[group('2030-10-20','completed',-1)]),e=>e.status===503);
  assert.throws(()=>buildActivityBusiness(filter({category:'clinic'}),[group('2030-10-20','completed',1,'spa_bath')]),e=>e.status===503);
});
test('moving an appointment date, undoing status and changing notes reflect current source membership',()=>{
  const original=buildActivityBusiness(filter(),[group('2030-10-20','completed',1)]);
  const moved=buildActivityBusiness(filter(),[group('2030-09-20','completed',1)]);
  assert.equal(original.current.total,1);assert.equal(moved.current.total,0);assert.equal(moved.previous.total,1);
  assert.deepEqual(moved.comparison,{totalDelta:-1,totalDeltaPercent:-100});
  const undone=buildActivityBusiness(filter(),[group('2030-10-20','pending',1)]);
  assert.equal(undone.current.total,1);assert.equal(undone.current.byStatus.completed,0);assert.equal(undone.current.byStatus.pending,1);
  const noteOnly=buildActivityBusiness(filter(),[{...group('2030-10-20','pending',1),internalNote:'not-an-activity-dimension'}]);
  assert.deepEqual(noteOnly,undone);
});
test('source groups in SQL with bound date/category values and one readonly RepeatableRead snapshot',async()=>{
  const sql=activitySourceStatement(filter({category:'spa'}));assert.match(sql.text,/GROUP BY a.appointment_date, a.type, a.status/);
  assert.equal(sql.values[0],'2030-08-22');assert.equal(sql.values[1],'2030-10-20');assert.match(sql.text,/::date/);assert.deepEqual(sql.values.slice(2),['spa_bath','spa_grooming','spa_combo']);
  const {db,calls}=database([group('2030-10-20','completed',1)]);
  const r=await new ClinicActivityQueries(db).read(filter());
  assert.equal(r.meta.source,'source');assert.equal(calls.length,1);assert.equal(calls[0].options.isolationLevel,'RepeatableRead');
  assert.equal(calls[0].setup[0],'SET TRANSACTION READ ONLY');assert.match(calls[0].setup[1],/statement_timeout/);
});
test('cache TTL is absolute from snapshot start, hits do not slide it and returned values cannot mutate cache',async()=>{
  let now=0;const {db,calls}=database([group('2030-10-20','completed',1)]),reader=new ClinicActivityQueries(db,'cached',()=>now,()=>new Date(now));
  assert.equal((await reader.read(filter())).meta.source,'source');now=4000;
  const hit=await reader.read(filter());assert.equal(hit.meta.source,'cached');assert.equal(hit.meta.cacheComputedAt,new Date(0).toISOString());hit.current.total=999;
  assert.equal((await reader.read(filter())).current.total,1);now=5000;
  assert.equal((await reader.read(filter())).meta.source,'source');assert.equal(calls.length,2);
});
test('slow computations past TTL are not published as fresh cache entries and errors do not poison cache',async()=>{
  let now=0,fail=false;const {db,calls}=database([],()=>{now+=5001;if(fail)throw new Error('fixture failure');return [];});
  const reader=new ClinicActivityQueries(db,'cached',()=>now);await reader.read(filter());await reader.read(filter());assert.equal(calls.length,2);
  fail=true;await assert.rejects(reader.read(filter()));fail=false;await reader.read(filter());assert.equal(calls.length,4);
});
test('cold requests coalesce with at most four waiting callers, including same-key callers',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const {db,calls}=database([],async()=>{enter();await gate;return [];});const reader=new ClinicActivityQueries(db,'cached');
  const a=reader.read(filter());await entered;const same=Array.from({length:4},()=>reader.read(filter()));
  await assert.rejects(reader.read(filter()),e=>e.status===503);
  release();await Promise.all([a,...same]);assert.equal(calls.length,1);
});
test('distinct cache misses use one computation and at most four queued callers',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const {db,calls}=database([],async()=>{enter();await gate;return [];});const reader=new ClinicActivityQueries(db,'cached');
  const a=reader.read(filter());await entered;
  const queued=Array.from({length:4},(_,i)=>reader.read(filter({from:`2030-10-${String(i+1).padStart(2,'0')}`})));
  await assert.rejects(reader.read(filter({from:'2030-10-09'})),e=>e.status===503);
  release();await Promise.all([a,...queued]);assert.equal(calls.length,5);
});
test('source requests are bounded to two, with no unbounded queue',async()=>{
  let release;const gate=new Promise(r=>release=r);const {db}=database([],async()=>{await gate;return [];});const reader=new ClinicActivityQueries(db);
  const a=reader.read(filter()),b=reader.read(filter());await assert.rejects(reader.read(filter()),e=>e.status===503);release();await Promise.all([a,b]);
});
test('cache admission expires on its original deadline and caches stay scoped to their database instance',async()=>{
  let now=0,release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r);
  const {db}=database([],async()=>{enter();await gate;return [];});const reader=new ClinicActivityQueries(db,'cached',()=>now);
  const active=reader.read(filter());await entered;
  const queued=reader.read(filter({category:'spa'}));const rejected=assert.rejects(queued,e=>e.status===503);
  now=2501;release();await Promise.all([active,rejected]);
  const first=new ClinicActivityQueries(database([group('2030-10-20','completed',1)]).db,'cached');
  const second=new ClinicActivityQueries(database([group('2030-10-20','completed',99)]).db,'cached');
  await first.read(filter());assert.equal((await second.read(filter())).current.total,99);assert.equal((await first.read(filter())).current.total,1);
});
test('UI presets use Vietnam business date and only daily scoped authoritative drilldowns',()=>{
  assert.deepEqual(activityPreset('30days','2030-10-20'),{from:'2030-09-21',to:'2030-10-20',groupBy:'day'});
  assert.deepEqual(activityPreset('12months','2030-10-20'),{from:'2029-11-01',to:'2030-10-20',groupBy:'month'});
  const link=activityDrilldown('2030-10-20','clinic','cancelled'),read=readActivityDrilldown(link.split('?')[1]);
  assert.equal(read.category,'medical');assert.equal(read.status,'cancelled');assert.equal(read.date,'2030-10-20');assert.equal(read.error,'');
  assert.match(readActivityDrilldown('activity=1&date=2030-02-30&consistency=authoritative').error,/./);
  assert.equal(validActivityFilters({from:'2028-01-01',to:'2028-12-31',groupBy:'day',category:'all'}),true);
});
test('seeded 10k fixture covers types/statuses, hot and empty buckets, valid ownership and unique slots',()=>{
  const a=buildActivityFixture(),b=buildActivityFixture();assert.equal(a.manifest.contentSha256,b.manifest.contentSha256);
  assert.equal(a.appointments.length,10000);assert.equal(new Set(a.appointments.map(r=>r.type)).size,10);assert.equal(new Set(a.appointments.map(r=>r.status)).size,7);
  assert.equal(new Set(a.appointments.map(r=>[r.petId,r.appointmentDate,r.appointmentTime].join('|'))).size,10000);
  const pets=new Map(a.pets.map(p=>[p.id,p]));assert.ok(a.appointments.every(r=>pets.get(r.petId).ownerId===r.ownerId));
  const hot=a.appointments.filter(r=>r.appointmentDate==='2030-10-20').length;assert.ok(hot>10&&hot<100);assert.ok(!a.appointments.some(r=>r.appointmentDate==='2030-10-13'));
});
