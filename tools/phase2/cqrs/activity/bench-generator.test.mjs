// Generator plan/dispatch/validity tests (synthetic executor; not app measurements).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {productPlan,runPlan,generatorValidity,nearestRank,lockedValidity} from './bench/generator.mjs';

test('locked validity rule equals benchmark-plan generatorValidity; nearest-rank percentile keeps timeouts',()=>{
  const g=JSON.parse(readFileSync('phase2-plan/cqrs/clinic-activity/evidence/benchmark-plan-20261021.json','utf8')).generatorValidity;
  assert.deepEqual(lockedValidity,{maximumGeneratorDrops:g.maximumGeneratorDropsForHealthyAcceptance,dispatchLatenessP99MaxMs:g.dispatchLatenessP99MaxMs,dispatchLatenessMaxMs:g.dispatchLatenessMaxMs,minimumPlannedDispatchFractionInsideMeasuredWindow:g.minimumPlannedDispatchFractionInsideMeasuredWindow});
  assert.equal(g.percentile,'nearest_rank');
  assert.equal(nearestRank([1,2,3,4,5,6,7,8,9,10],0.95),10);assert.equal(nearestRank([5,1,3],0.5),3);assert.equal(nearestRank([1,Infinity],0.95),Infinity);
  assert.equal(nearestRank([],0.95),null);assert.throws(()=>nearestRank([1],0));
});
test('product plan matches policy productLoad: 10 staggered screens/15s, 0.1 writes/s, 20/20/60 mix, measured window',()=>{
  const p=productPlan(),measured=p.ops.filter(o=>o.measured);
  assert.equal(measured.filter(o=>o.kind==='read').length,1200);assert.equal(measured.filter(o=>o.kind==='write').length,180);
  const starts=[...new Set(p.ops.filter(o=>o.kind==='read'&&o.offsetMs<15000).map(o=>o.offsetMs))];assert.equal(starts.length,10);
  const w=p.ops.filter(o=>o.kind==='write'),share=k=>w.filter(o=>o.operation===k).length/w.length;
  assert.ok(Math.abs(share('status')-0.6)<0.1&&Math.abs(share('create')-0.2)<0.1);
  assert.deepEqual(productPlan().ops,p.ops,'seeded, deterministic');
  assert.throws(()=>productPlan({writeMix:{create:0.5}}),/INVALID_WRITE_MIX/);
});
test('open loop dispatches on schedule independent of slow completions; cap overflow is a recorded drop',async()=>{
  const plan=productPlan({screens:4,pollMs:200,warmupMs:100,measuredMs:600,writesPerSecond:5});
  const fast=await runPlan(plan,async()=>{await new Promise(r=>setTimeout(r,5));return {result:'success',status:200};});
  const v=generatorValidity(plan,fast.records);assert.equal(v.valid,true,JSON.stringify(v));assert.equal(v.drops,0);
  // Completions 400ms late must not delay later dispatches (open loop).
  const slow=await runPlan(plan,async()=>{await new Promise(r=>setTimeout(r,400));return {result:'success',status:200};});
  assert.ok(generatorValidity(plan,slow.records).latenessMaxMs<100);assert.ok(slow.records.every(r=>r.completedMs-r.dispatchedMs>=390));
  const capped=await runPlan(plan,async()=>{await new Promise(r=>setTimeout(r,400));return {result:'success'};},{maxInFlight:2});
  const c=generatorValidity(plan,capped.records);assert.equal(c.valid,false);assert.ok(c.reasons.includes('generator_drops'));
  const timed=await runPlan(productPlan({screens:1,pollMs:100,warmupMs:0,measuredMs:150,writesPerSecond:0}),()=>new Promise(()=>{}),{timeoutMs:50});
  assert.ok(timed.records.every(r=>r.outcome.result==='timeout'));
});
test('validity boundaries: p99 lateness 100 ok/101 fail, max 1000 ok/1001 fail, 99% inside window, missing timestamps',()=>{
  const plan={warmupMs:0,measuredMs:10000,ops:Array.from({length:100},(_,i)=>({id:i,measured:true,offsetMs:i*10}))};
  const recs=late=>plan.ops.map((o,i)=>({id:o.id,measured:true,scheduledMs:o.offsetMs,dispatchedMs:o.offsetMs+late(i),completedMs:o.offsetMs+late(i)+1,outcome:{result:'success'}}));
  assert.equal(generatorValidity(plan,recs(()=>100)).valid,true);
  assert.ok(generatorValidity(plan,recs(()=>101)).reasons.includes('dispatch_lateness_p99'));
  assert.equal(generatorValidity(plan,recs(i=>i===99?1000:0)).valid,true);
  assert.ok(generatorValidity(plan,recs(i=>i===99?1001:0)).reasons.includes('dispatch_lateness_max'));
  // Two of 100 planned ops dispatched after the window: 98% < 99%.
  assert.ok(generatorValidity(plan,recs(i=>i>=98?20000:0)).reasons.includes('dispatch_fraction_inside_window'));
  const broken=recs(()=>0);broken[5].completedMs=null;assert.ok(generatorValidity(plan,broken).reasons.includes('missing_timestamps_or_outcome'));
  assert.ok(generatorValidity(plan,recs(()=>0).slice(1)).reasons.includes('planned_count_mismatch'));
});
