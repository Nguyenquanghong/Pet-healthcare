import assert from 'node:assert/strict';

// Recompute gates from every recorded sample, never trust a precomputed PASS,
// discard failures, or average percentiles across runs.
export function evaluateFaultEvidence(policy,cases,billing,admin){
 const pairs=policy.correctness.racePairsPerScenario;
 for(const [name,rows,winner] of [
  ['status-undo',cases.races.filter(r=>r.scenario==='status-undo'),'winner'],
  ['slot',cases.races.filter(r=>r.scenario==='slot'),'winnerReplica'],
  ['prepare-undo',billing.prepareUndo,'winner'],['commit-abort',billing.commitAbort,'winner']]){
  assert.equal(rows.length,pairs,name+' sample count');assert.equal(new Set(rows.map(r=>r.pair)).size,pairs,name+' unique pairs');
  const winners=new Map();for(const r of rows){assert.ok(r.status==='PASS'||JSON.stringify(r.status)===JSON.stringify(name==='slot'?[201,409]:[200,409]),name+' failed pair');winners.set(r[winner],(winners.get(r[winner])??0)+1);}
  assert.equal(winners.size,2,name+' both lock orders');assert.ok([...winners.values()].every(n=>n===pairs/2),name+' balanced orders');
 }
 assert.equal(cases.freshness.length,policy.freshness.runs);
 const freshness=cases.freshness.map(run=>{
  assert.equal(run.status,'PASS');assert.equal(run.samples.length,policy.freshness.mutationsPerRun);
  assert.equal(new Set(run.samples.map(s=>s.id)).size,run.samples.length);
  for(const s of run.samples){assert.equal(s.status,'PASS');assert.equal(s.rywStatus,200);assert.ok(['projection','authoritative'].includes(s.rywSource));assert.ok(Number.isFinite(s.visibleMs)&&s.visibleMs>=0);}
  const sorted=run.samples.map(s=>s.visibleMs).sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1],p99=sorted[Math.ceil(sorted.length*.99)-1];
  assert.ok(p95<=policy.freshness.p95MsMax);assert.ok(p99<=policy.freshness.p99MsMax);return{run:run.run,samples:sorted.length,p95,p99};
 });
 assert.equal(cases.recovery.length,policy.recovery.runs);
 for(const run of cases.recovery){assert.equal(run.status,'PASS');assert.ok(run.outageMs>=policy.recovery.projectorOutageSeconds*1000);assert.ok(run.catchUpMs>=0&&run.catchUpMs<=policy.recovery.catchUpSecondsMax*1000);assert.equal(run.validDlq,0);assert.ok(run.expected.length>0&&run.expected.length<=policy.recovery.inputEventsMax);assert.equal(new Set(run.expected.map(s=>s.id)).size,run.expected.length);
  for(let i=0;i<run.expected.length;i++){const current=run.expected[i];assert.ok(current.version>=1&&current.acceptedMs>=0&&current.acceptedMs<=run.outageMs);if(i>=policy.recovery.inputEventsPerSecondMax)assert.ok(current.acceptedMs-run.expected[i-policy.recovery.inputEventsPerSecondMax].acceptedMs>=1000,'input rate exceeded');}
 }
 assert.equal(admin.samples.length,policy.freshness.adminWindowCases);assert.equal(new Set(admin.samples.map(s=>s.id)).size,admin.samples.length);
 for(const s of admin.samples){assert.equal(s.status,'PASS');assert.ok(Number.isFinite(s.visibleMs)&&s.visibleMs>=0&&s.visibleMs<=policy.freshness.adminWindowMsMax);}
 assert.ok(admin.sources.projection>0);assert.equal(cases.remainingConsumers,0);assert.ok(cases.rollback.projectionTableUnavailable&&cases.rollback.tokenOptional);assert.equal(cases.rollback.replicas,2);
 return{status:'PASS',racePairs:4*pairs,freshness,recovery:cases.recovery.map(r=>({run:r.run,events:r.expected.length,outageMs:r.outageMs,catchUpMs:r.catchUpMs})),adminCases:admin.samples.length,adminMaxMs:Math.max(...admin.samples.map(s=>s.visibleMs))};
}
