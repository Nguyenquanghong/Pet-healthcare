// D3 unit scope: evidence/eligibility rules and audit budget settings with fake
// transactions. Real rebuild/reconciliation evidence is summary-rebuild.integration.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivitySummaryEvidence,AuditLane} from '../../../../services/clinic/dist/activitySummaryEvidence.js';
import {ReadFreshness} from '../../../../services/clinic/dist/readFreshness.js';

const g='generation-v2';
function fakeDb({schemaVersion=2,state='ACTIVE',frozen=0,drift=0,fail=false,listMode='authoritative',hold}={}){
  const calls=[];
  const db={$transaction:async(work,options)=>{const setup=[];calls.push({options,setup});
    return work({$executeRawUnsafe:async sql=>setup.push(sql),
      readProjectionControl:{findUnique:async()=>({servingMode:listMode,activeGenerationId:g,activeGeneration:{id:g,state,schemaVersion,verifiedAt:new Date(),projectionName:'appointments'}})},
      readRebuildRun:{count:async()=>frozen},
      $queryRaw:async()=>{if(hold)await hold();if(fail)throw new Error('statement timeout');return [{rows:drift,source:null,pending:0,oldest:null,bad:0}];}});}};
  return {db,calls};
}
const rowsOk={evidence:{generation:g,schemaVersion:2},unusableReason:()=>undefined};
function evidence(opts={},{rows=rowsOk,capability=[1,2],clock}={}){
  const {db,calls}=fakeDb(opts);let now=1_000_000;
  const e=new ActivitySummaryEvidence(db,rows,capability,new AuditLane(),clock??(()=>now));
  return {e,calls,advance:ms=>{now+=ms;}};
}

test('healthy V2 reconciliation is eligible; budgets match ADR (RR read-only, 1500/2500/50ms, no parallel workers)',async()=>{
  const {e,calls}=evidence();await e.sample();
  assert.equal(e.ineligibleReason(g),undefined);assert.equal(e.evidence.driftBuckets,0);
  assert.deepEqual(calls[0].options,{isolationLevel:'RepeatableRead',maxWait:50,timeout:2500});
  assert.deepEqual(calls[0].setup,['SET TRANSACTION READ ONLY',"SET LOCAL statement_timeout='1500ms'",'SET LOCAL max_parallel_workers_per_gather=0']);
});

test('drift, V1/unverified generation, frozen rebuild, sample error and V1-only binary are ineligible',async()=>{
  const drift=evidence({drift:3});await drift.e.sample();assert.equal(drift.e.ineligibleReason(g),'summary_drift');assert.equal(drift.e.stats.drift,1);
  const v1=evidence({schemaVersion:1});await v1.e.sample();assert.equal(v1.e.ineligibleReason(g),'summary_not_v2');assert.equal(v1.e.evidence,undefined);
  const building=evidence({state:'READY'});await building.e.sample();assert.equal(building.e.ineligibleReason(g),'summary_generation_missing');
  const frozen=evidence({frozen:1});await frozen.e.sample();assert.equal(frozen.e.ineligibleReason(g),'summary_frozen');
  const failed=evidence({fail:true});await failed.e.sample();assert.equal(failed.e.ineligibleReason(g),'summary_sample_error');
  const l=evidence({},{capability:[1]});await l.e.sample();assert.equal(l.e.ineligibleReason(g),'capability_v1_only');
  // A failure seen on another generation is reported as generation mismatch, not reused.
  assert.equal(v1.e.ineligibleReason('new-v2-generation'),'summary_evidence_generation');assert.equal(v1.e.ineligibleReason(g),'summary_not_v2');
  // A healthy sample after drift clears the failure only by new evidence.
  const recover=evidence({drift:1});await recover.e.sample();assert.equal(recover.e.ineligibleReason(g),'summary_drift');
});

test('evidence expires after 60s, rejects clock skew and other generations; row evidence must be usable for the same V2 generation',async()=>{
  const {e,advance}=evidence();await e.sample();
  advance(60_000);assert.equal(e.ineligibleReason(g),undefined);advance(1);assert.equal(e.ineligibleReason(g),'summary_evidence_expired');
  const skew=evidence();await skew.e.sample();skew.advance(-1);assert.equal(skew.e.ineligibleReason(g),'summary_evidence_clock');
  assert.equal(skew.e.ineligibleReason('other'),'summary_evidence_generation');
  const missing=evidence();assert.equal(missing.e.ineligibleReason(g),'summary_evidence_missing');
  const lag=evidence({},{rows:{evidence:{generation:g,schemaVersion:2},unusableReason:()=>'freshness_lag'}});await lag.e.sample();assert.equal(lag.e.ineligibleReason(g),'rows_freshness_lag');
  const broker=evidence({},{rows:{evidence:undefined,unusableReason:()=>'freshness_missing'}});await broker.e.sample();assert.equal(broker.e.ineligibleReason(g),'rows_freshness_missing');
  const v1rows=evidence({},{rows:{evidence:{generation:g,schemaVersion:1},unusableReason:()=>undefined}});await v1rows.e.sample();assert.equal(v1rows.e.ineligibleReason(g),'rows_schema_version');
});

test('one sample in flight; audit lane serializes row and summary audits on one connection',async()=>{
  let release;const held=new Promise(r=>release=r);let entered=0;
  const {db,calls}=fakeDb({hold:async()=>{entered++;await held;}});
  const e=new ActivitySummaryEvidence(db,rowsOk,[1,2]);
  const a=e.sample(),b=e.sample();assert.equal(a,b);await new Promise(r=>setImmediate(r));assert.equal(entered,1);release();await a;assert.equal(calls.length,1);
  const lane=new AuditLane(),order=[];let open;const gate=new Promise(r=>open=r);
  const first=lane.run(async()=>{order.push('row-start');await gate;order.push('row-end');});
  const second=lane.run(async()=>{order.push('summary');});
  await new Promise(r=>setImmediate(r));assert.deepEqual(order,['row-start']);open();await Promise.all([first,second]);
  assert.deepEqual(order,['row-start','row-end','summary']);
  await assert.rejects(lane.run(async()=>{throw new Error('x');}));assert.equal(await lane.run(async()=>7),7);
});

test('ReadFreshness keeps list guard by default; activity option audits the active generation while list stays authoritative',async()=>{
  const list=fakeDb({listMode:'authoritative'}),guarded=new ReadFreshness(list.db,async()=>true,()=>5);await guarded.sample();
  assert.equal(guarded.evidence,undefined);assert.equal(guarded.unusableReason(g),'freshness_missing');
  const activity=fakeDb({listMode:'authoritative'}),lane=new AuditLane(),independent=new ReadFreshness(activity.db,async()=>true,()=>5,undefined,{requireListProjection:false,perAggregateLag:true,lane});
  await independent.sample();assert.deepEqual({generation:independent.evidence.generation,schemaVersion:independent.evidence.schemaVersion,healthy:independent.evidence.healthy},{generation:g,schemaVersion:2,healthy:true});
  assert.equal(independent.usable(g),true);
  const broker=new ReadFreshness(fakeDb().db,async()=>false,()=>5,undefined,{requireListProjection:false});await broker.sample();assert.equal(broker.evidence,undefined);
  const projected=fakeDb({listMode:'projection'}),old=new ReadFreshness(projected.db,async()=>true,()=>5);await old.sample();assert.equal(old.usable(g),true);
});

// D5: scripted samples; each step = pending items (id, changedAt, projected) or a bare overflow count.
function scripted(steps,listMode='projection'){
  let i=-1;const db={$transaction:async work=>{i++;const step=steps[i];let q=0;
    return work({$executeRawUnsafe:async()=>{},readRebuildRun:{count:async()=>0},
      readProjectionControl:{findUnique:async()=>({servingMode:listMode,activeGeneration:{id:step.generation??g,state:'ACTIVE',schemaVersion:2,verifiedAt:new Date(),projectionName:'appointments'}})},
      $queryRaw:async()=>{q++;const items=step.items??[],pending=step.overflow??items.length;
        if(q===1)return [{pending,oldest:pending?new Date(step.oldest??Math.min(...items.map(x=>x.changed))):null,bad:0}];
        return items.map(x=>({id:x.id,changed:new Date(x.changed),projected:x.projected}));}});}};
  return db;
}
function lagRun(steps,options){
  let now=0;const f=new ReadFreshness(scripted(steps),async()=>true,()=>now,undefined,options);
  return async()=>{const out=[];for(const step of steps){now=step.at;await f.sample();out.push(f.evidence.lagMs);}return out;};
}

test('per-aggregate lag: steady writes on different aggregates do not accumulate; a stuck aggregate does; version progress resets',async()=>{
  // One new change each sample (1 write/s, projected ~100ms later), always a different aggregate.
  const steady=Array.from({length:10},(_,k)=>({at:k*2000+50,items:[{id:'a'+k,changed:k*2000,projected:1}]}));
  const per=await lagRun(steady,{requireListProjection:false,perAggregateLag:true})();
  assert.ok(per.every(l=>l===50),JSON.stringify(per));
  // Default list estimator is unchanged: it carries the first pending time forward.
  const list=await lagRun(steady)();assert.equal(list.at(-1),18050);
  // Same aggregate stuck at the same projected version accumulates from first sight.
  const stuck=await lagRun([{at:100,items:[{id:'x',changed:0,projected:1}]},{at:2100,items:[{id:'x',changed:0,projected:1}]},{at:4100,items:[{id:'x',changed:4000,projected:1}]}],{requireListProjection:false,perAggregateLag:true})();
  assert.deepEqual(stuck,[100,2100,4100]);
  // Same aggregate pending again but the projection advanced in between: new change, new clock.
  const moved=await lagRun([{at:100,items:[{id:'x',changed:0,projected:1}]},{at:2100,items:[{id:'x',changed:2000,projected:2}]}],{requireListProjection:false,perAggregateLag:true})();
  assert.deepEqual(moved,[100,100]);
  // Clean sample clears; changedAt in the future is clamped to the sample start.
  const clean=await lagRun([{at:100,items:[{id:'x',changed:0,projected:1}]},{at:2100,items:[]},{at:4100,items:[{id:'y',changed:9000,projected:null}]}],{requireListProjection:false,perAggregateLag:true})();
  assert.deepEqual(clean,[100,0,0]);
});

test('per-aggregate lag: over 1000 pending keeps a global carry until a clean sample; generation change resets',async()=>{
  const opts={requireListProjection:false,perAggregateLag:true};
  const over=await lagRun([{at:100,overflow:1001,oldest:0},{at:2100,overflow:1500,oldest:2000},{at:4100,items:[{id:'z',changed:4000,projected:1}]},{at:6100,items:[]},{at:8100,items:[{id:'z',changed:8000,projected:1}]}],opts)();
  assert.deepEqual(over,[100,2100,4100,0,100]);
  const regen=await lagRun([{at:100,items:[{id:'x',changed:0,projected:1}]},{at:2100,generation:'g-next',items:[{id:'x',changed:0,projected:1}]}],opts)();
  assert.deepEqual(regen,[100,2100]);
});
