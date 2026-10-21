// D4 unit scope: selector, summary reader eligibility and whole-response fallback
// with fake transactions. Real PostgreSQL parity is summary-reader.integration.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseActivityFilter} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {ClinicActivityQueries,activitySummaryStatement} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';

const g='generation-v2',filter=(more={})=>parseActivityFilter({from:'2030-09-21',to:'2030-10-20',...more});
const rows=[{date:'2030-10-20',type:'general_checkup',status:'completed',n:5n},{date:'2030-10-19',type:'spa_bath',status:'cancelled',n:2n},{date:'2030-09-01',type:'dental',status:'no_show',n:1n}];
function fakeDb({generation={id:g,state:'ACTIVE',schemaVersion:2,verifiedAt:new Date(),projectionName:'appointments'},frozen=0,fail=false,hold,control={servingMode:'summary'},controlFail=false}={}){
  const calls=[];let holds=0;
  const db={calls,
    clinicActivityControl:{findUnique:async()=>{if(controlFail)throw new Error('down');return control;}},
    $transaction:async(work,options)=>{const call={options,setup:[],sql:[]};calls.push(call);
      return work({$executeRawUnsafe:async s=>call.setup.push(s),
        readProjectionControl:{findUnique:async()=>({activeGenerationId:generation?.id??null,servingMode:'authoritative',activeGeneration:generation})},
        readRebuildRun:{count:async()=>frozen},
        $queryRaw:async sql=>{const text=sql.strings.join('?');call.sql.push(text);
          if(text.includes('AppointmentDailySummary')){if(fail)throw new Error('PRIVATE_SUMMARY_ERROR');call.summary=sql.values;}
          else if(hold){holds++;await hold();}
          return structuredClone(rows);}});}};
  return db;
}
const evidence=(reason)=>({ineligibleReason:()=>reason,observed:()=>({checkedAt:Date.UTC(2030,9,20,1),lagMs:120})});

test('eligible summary: one RR read-only snapshot, bounded budget, generation metadata and same business DTO as source',async()=>{
  const db=fakeDb(),q=new ClinicActivityQueries(db,'summary',undefined,undefined,evidence());
  const r=await q.read(filter());
  assert.deepEqual(r.meta.source,'summary');assert.equal(r.meta.generation,g);assert.equal(r.meta.degraded,false);assert.equal(r.meta.reason,null);assert.equal(r.meta.cacheComputedAt,null);
  assert.deepEqual(r.meta.freshness,{state:'within-policy',checkedAt:'2030-10-20T01:00:00.000Z',observedLagMs:120});
  assert.equal(db.calls.length,1);assert.equal(db.calls[0].options.isolationLevel,'RepeatableRead');assert.ok(db.calls[0].options.maxWait<=50&&db.calls[0].options.timeout<=2500);
  assert.equal(db.calls[0].setup[0],'SET TRANSACTION READ ONLY');assert.match(db.calls[0].setup[1],/statement_timeout='(1500|\d{1,3})ms'/);
  assert.equal(db.calls[0].summary[0],g);
  const s=await new ClinicActivityQueries(fakeDb(),'source').read(filter());
  const {meta:_a,...pb}=r,{meta:_b,...sb}=s;assert.deepEqual(pb,sb);
});

test('ineligible generation/fence/evidence falls back to the WHOLE source response with the reason; never mixed',async()=>{
  const cases=[[{generation:{id:g,state:'ACTIVE',schemaVersion:1,verifiedAt:new Date(),projectionName:'appointments'}},undefined,'summary_not_v2'],
    [{generation:{id:g,state:'READY',schemaVersion:2,verifiedAt:new Date(),projectionName:'appointments'}},undefined,'summary_generation_missing'],
    [{generation:{id:g,state:'ACTIVE',schemaVersion:2,verifiedAt:null,projectionName:'appointments'}},undefined,'summary_generation_missing'],
    [{generation:null},undefined,'summary_generation_missing'],[{frozen:1},undefined,'summary_frozen'],
    [{},'summary_drift','summary_drift'],[{},'rows_freshness_lag','rows_freshness_lag'],[{},'summary_evidence_expired','summary_evidence_expired'],
    [{fail:true},undefined,'summary_query_error']];
  for(const [opts,reason,expected] of cases){
    const db=fakeDb(opts),r=await new ClinicActivityQueries(db,'summary',undefined,undefined,evidence(reason)).read(filter());
    assert.deepEqual([r.meta.source,r.meta.generation,r.meta.degraded,r.meta.reason,r.meta.freshness.state],['source',null,true,expected,'current'],expected);
    assert.ok(!JSON.stringify(r).includes('PRIVATE'));
    // Fallback is a separate source snapshot; no summary rows leak into it.
    assert.ok(db.calls.at(-1).sql.every(t=>!t.includes('AppointmentDailySummary')));
  }
  const unconfigured=await new ClinicActivityQueries(fakeDb(),'summary').read(filter());assert.equal(unconfigured.meta.reason,'summary_evidence_unconfigured');
  const unobserved=await new ClinicActivityQueries(fakeDb(),'summary',undefined,undefined,{ineligibleReason:()=>undefined,observed:()=>undefined}).read(filter());assert.equal(unobserved.meta.reason,'summary_evidence_missing');
});

test('fallback is bounded: two source computations per replica, third ineligible request gets 503',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const db=fakeDb({frozen:1,hold:()=>gate}),q=new ClinicActivityQueries(db,'summary',undefined,undefined,evidence());
  const a=q.read(filter()),b=q.read(filter());await new Promise(r=>setImmediate(r));
  await assert.rejects(q.read(filter()),e=>e.status===503);release();
  for(const r of await Promise.all([a,b]))assert.equal(r.meta.reason,'summary_frozen');
  // Deadline already spent before the summary snapshot: no summary query, and the
  // fallback has no budget left either, so 503 instead of an unbounded source query.
  let calls=0;const lateDb=fakeDb(),late=new ClinicActivityQueries(lateDb,'summary',()=>calls++===0?0:10_000,undefined,evidence());
  await assert.rejects(late.read(filter()),e=>e.status===503);assert.equal(lateDb.calls.length,0);
});

test('operator control selects source/cached/summary; unknown, failed, invalid or stale control serves source as degraded',async()=>{
  let now=0;const clock=()=>now;
  const q=new ClinicActivityQueries(fakeDb({control:{servingMode:'summary'}}),'control',clock,undefined,evidence(),1000);
  assert.deepEqual(q.effectiveMode(),{mode:'source',reason:'activity_control_unknown'});
  const before=await q.read(filter());assert.deepEqual([before.meta.source,before.meta.degraded,before.meta.reason],['source',true,'activity_control_unknown']);
  await q.refreshControl();assert.deepEqual(q.effectiveMode(),{mode:'summary'});assert.equal((await q.read(filter())).meta.source,'summary');
  now=3001;assert.deepEqual(q.effectiveMode(),{mode:'source',reason:'activity_control_unknown'});
  for(const control of [{servingMode:'projection'},null]){const x=new ClinicActivityQueries(fakeDb({control}),'control',clock,undefined,evidence());await x.refreshControl();assert.equal(x.effectiveMode().mode,'source');}
  const failed=new ClinicActivityQueries(fakeDb({controlFail:true}),'control',clock,undefined,evidence());await failed.refreshControl();assert.equal(failed.effectiveMode().reason,'activity_control_unknown');
  const cached=new ClinicActivityQueries(fakeDb({control:{servingMode:'cached'}}),'control',clock);await cached.refreshControl();
  assert.equal((await cached.read(filter())).meta.source,'source');assert.equal((await cached.read(filter())).meta.source,'cached');
  for(const fixed of ['source','cached','summary'])assert.deepEqual(new ClinicActivityQueries(fakeDb(),fixed).effectiveMode(),{mode:fixed});
  assert.throws(()=>new ClinicActivityQueries(fakeDb(),'projection'),/INVALID_CLINIC_ACTIVITY_MODE/);
  const polled=new ClinicActivityQueries(fakeDb(),'control',undefined,undefined,evidence(),1000);polled.start();await polled.close();
});

test('summary statement binds generation, period and category; only modelled dimensions',()=>{
  for(const [category,clause] of [['all',null],['spa',/IN \(/],['clinic',/NOT IN \(/]]){
    const sql=activitySummaryStatement(filter({category}),g),text=sql.strings.join('?');
    assert.ok(sql.values.includes(g));assert.ok(sql.values.includes('2030-08-22'));assert.ok(sql.values.includes('2030-10-20'));
    if(clause)assert.match(text,clause);else assert.doesNotMatch(text,/IN \(/);
    assert.doesNotMatch(text,/owner|pet|doctor|note|billing/i);
  }
});
