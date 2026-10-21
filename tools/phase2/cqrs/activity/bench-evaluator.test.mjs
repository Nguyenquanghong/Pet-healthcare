// Evaluator boundary tests on SYNTHETIC fixtures. These are not application
// measurements and must never be reported as benchmark results.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluate,classify} from './bench/evaluator.mjs';

const real=readFileSync('phase2-plan/cqrs/clinic-activity/acceptance.frozen.json');
// Same thresholds; only the two freeze flags flipped in memory to exercise grading.
const frozen=Buffer.from(JSON.stringify({...JSON.parse(real),fullyFrozen:true,performanceMeasurementsAllowed:true}));
const sha=b=>createHash('sha256').update(b).digest('hex'),h=c=>c.repeat(64);
const prov=policy=>({sourceTreeSha256:h('a'),buildSha256:h('b'),fixtureSha256:h('c'),traceSha256:h('d'),harnessSha256:h('e'),policySha256:sha(policy)});
const G='gen-v2';
// Synthetic run: n measured primary reads all at latency p95, w writes at writeMs.
function run({id,label,kind,block,position=0,p95=100,n=1200,w=180,writeMs=40,cpu=10,complete=true,source,generation,status=200,degraded=false,drop=false,policy=frozen,ops={create:0.2,reschedule:0.2,status:0.6}}){
  const records=[],planOps=[];
  for(let i=0;i<n;i++){planOps.push({id:i,measured:true,offsetMs:i});records.push({id:i,kind:'read',operation:'primary',measured:true,scheduledMs:i,dispatchedMs:i+1,completedMs:i+p95,
    outcome:drop&&i===0?{result:'generatorDrop'}:{result:'success',status,source:source??{S:'source',C:'cached',P:'summary',L:'source'}[label],generation:generation!==undefined?generation:label==='P'?G:null,degraded}});}
  const kinds=Object.entries(ops);
  for(let j=0;j<w;j++){const i=n+j;let at=(j%100)/100,op=kinds.at(-1)[0];for(const [k,v] of kinds){at-=v;if(at<0){op=k;break;}}
    planOps.push({id:i,measured:true,offsetMs:i});records.push({id:i,kind:'write',operation:op,measured:true,scheduledMs:i,dispatchedMs:i+1,completedMs:i+writeMs,outcome:{result:'success',status:201}});}
  return {id,label,kind,block,position,expectedGeneration:G,simpleReader:'S',profileKey:{resourceClass:'kaggle_shared_envelope',cpuModel:'x'},provenance:prov(policy),
    plan:{warmupMs:0,measuredMs:1800000,ops:planOps},records,resource:{complete,applicationCpuSeconds:complete?cpu:null}};
}
function study(over={}){
  const p=over.p??{},runs=[];const pos=(order,l)=>order.indexOf(l);
  const orders=[['S','C','P'],['P','S','C'],['C','P','S']];
  orders.forEach((order,b)=>{for(const l of order)runs.push(run({id:`path-${b}-${l}`,label:l,kind:'path',block:b,position:pos(order,l),p95:p[l]?.[l]??{S:200,C:200,P:100}[l],policy:over.policy??frozen,...(over.path?.[l]??{})}));});
  [['P','L'],['L','P'],['P','L']].forEach((order,b)=>{for(const l of order)runs.push(run({id:`cost-${b}-${l}`,label:l,kind:'cost',block:b,position:pos(order,l),policy:over.policy??frozen,...(over.cost?.[l]??{})}));});
  for(const l of ['S','C','P','L'])runs.push(run({id:'write-'+l,label:l,kind:'write',block:0,n:0,w:520,policy:over.policy??frozen,...(over.write?.[l]??{})}));
  const freshRun={backendMs:Array(1000).fill(1000),uiMs:Array(1000).fill(15000)};
  return {policySha256:sha(over.policy??frozen),runs:(over.mutate??(r=>r))(runs),selectedSimpleReader:over.selected??'S',cacheFreshnessPass:true,
    correctness:{sourceToReadRowMismatch:0,readRowToSummaryMismatch:0,negativeCounters:0,unauthorizedResponses:0,...(over.correctness??{})},
    freshness:{runs:over.freshness??[freshRun,freshRun,freshRun]},recovery:{runs:over.recovery??[1,2,3].map(()=>({outageSeconds:60,backlogEvents:300,catchUpSeconds:120,finalMismatches:0}))},
    historicalBridge:{status:over.bridge??'PASS'}};
}
const latency=(S,C,P)=>({p:{S:{S},C:{C},P:{P}}});
const decide=(over,policy=frozen)=>evaluate(study(over),policy);

test('all gates pass => RECOMMEND_SUMMARY; boundaries 0.70 ratio, 50ms saving, 300ms and 1.10 inclusive',()=>{
  const e=decide(latency(250,250,175));assert.equal(e.decision,'RECOMMEND_SUMMARY',JSON.stringify(e.reasons));
  assert.equal(e.gates.primary.vsS.medianRatio,0.7);assert.equal(e.gates.primary.vsS.medianSavingMs,75);
  assert.equal(decide(latency(350,350,300)).decision,'RECOMMEND_SIMPLE');// 300ms max met but ratio 0.857
  assert.equal(decide(latency(430,430,300)).decision,'RECOMMEND_SUMMARY');// 300<=300, 0.6977, 130ms
  assert.equal(decide(latency(430,430,301)).decision,'RECOMMEND_SIMPLE');// P p95 above 300
});
test('relative and absolute benefit are both required against S and C',()=>{
  assert.equal(decide(latency(1000,1000,701)).reasons.simple.includes('relative_improvement_vs_S'),true);
  const small=decide(latency(160,160,111));assert.ok(small.reasons.simple.includes('absolute_saving_vs_S'));assert.equal(small.decision,'RECOMMEND_SIMPLE');// 0.694 but 49ms
  const onlyC=decide(latency(400,200,150));assert.ok(onlyC.reasons.simple.includes('relative_improvement_vs_C'));assert.equal(onlyC.decision,'RECOMMEND_SIMPLE');
});
test('one paired regression above 1.10 fails benefit even when medians pass',()=>{
  const e=decide({p:{},path:{P:{}}});assert.equal(e.decision,'RECOMMEND_SUMMARY');
  const bad=evaluate(study({mutate:runs=>runs.map(r=>r.id==='path-2-P'?run({...r,id:r.id,label:'P',kind:'path',block:2,position:1,p95:221}):r)}),frozen);
  assert.ok(bad.reasons.simple.includes('paired_regression_vs_S'));assert.equal(bad.gates.primary.vsS.worstRatio,1.105);
});
test('999 primary successes, an incomplete block or differing profile key => INCONCLUSIVE, never a winner',()=>{
  assert.equal(evaluate(study({mutate:r=>r.map(x=>x.id==='path-1-S'?run({...x,label:'S',kind:'path',block:1,position:1,p95:200,n:999}):x)}),frozen).decision,'INCONCLUSIVE');
  assert.equal(evaluate(study({mutate:r=>r.filter(x=>x.id!=='path-2-C')}),frozen).decision,'INCONCLUSIVE');
  const e=evaluate(study({mutate:r=>r.map(x=>x.id==='cost-1-L'?{...x,profileKey:{...x.profileKey,cpuModel:'other'}}:x)}),frozen);
  assert.equal(e.decision,'INCONCLUSIVE');assert.ok(e.reasons.inconclusive.includes('profile_key_strata_differ'));
});
test('missing CPU coverage => TOTAL_COST_INCONCLUSIVE and never RECOMMEND_SUMMARY from latency',()=>{
  const e=decide({cost:{L:{complete:false}}});assert.equal(e.decision,'INCONCLUSIVE');assert.equal(e.gates.totalCost.result,'INCONCLUSIVE');
  assert.ok(e.reasons.inconclusive.some(r=>r.startsWith('TOTAL_COST_INCONCLUSIVE')));
});
test('cost regressions: CPU/success 1.10 inclusive, 1.11 fails; throughput 0.90; write p95 1.10',()=>{
  assert.equal(decide({cost:{P:{cpu:11},L:{cpu:10}}}).decision,'RECOMMEND_SUMMARY');
  const cpu=decide({cost:{P:{cpu:11.1},L:{cpu:10}}});assert.equal(cpu.gates.totalCost.result,'FAIL');assert.equal(cpu.decision,'RECOMMEND_SIMPLE');
  assert.equal(decide({cost:{P:{writeMs:44}}}).decision,'RECOMMEND_SUMMARY');
  assert.equal(decide({cost:{P:{writeMs:45}}}).gates.totalCost.result,'FAIL');
  // Throughput exactly 0.90 passes; CPU scaled so CPU/success stays equal.
  const tp=decide({cost:{P:{n:1080,w:162,cpu:9}}});assert.equal(tp.gates.totalCost.result,'PASS',JSON.stringify(tp.gates.totalCost));
  assert.equal(decide({cost:{P:{n:1079,w:162,cpu:9}}}).gates.totalCost.result,'FAIL');
  assert.equal(decide({write:{P:{w:100}}}).gates.totalCost.result,'INCONCLUSIVE');// pooled writes < 1000 / ops < 200
});
test('correctness: wrong source/generation, healthy summary fallback, 401/403, 503 and mismatches => FAIL_CORRECTNESS',()=>{
  for(const over of [{path:{P:{source:'source'}}},{path:{P:{generation:'other'}}},{path:{P:{source:'source',degraded:true}}},{path:{S:{source:'summary'}}},
    {path:{S:{status:403}}},{path:{C:{status:503}}},{correctness:{readRowToSummaryMismatch:1}},{correctness:{negativeCounters:undefined}}])
    assert.equal(decide(over).decision,'FAIL_CORRECTNESS',JSON.stringify(over));
  assert.equal(classify({label:'P',expectedGeneration:G},{kind:'read',outcome:{result:'success',status:200,source:'source',degraded:true,generation:null}}).code,'fallback');
});
test('environment: generator drop, policy not frozen/sha mismatch, missing provenance => INVALID_ENVIRONMENT',()=>{
  assert.equal(decide({path:{S:{drop:true}}}).decision,'INVALID_ENVIRONMENT');
  assert.equal(evaluate(study({policy:real}),real).decision,'INVALID_ENVIRONMENT');
  const e=evaluate(study(),real);assert.ok(e.reasons.environment.includes('policy_sha_mismatch'));
  assert.equal(evaluate(study({mutate:r=>r.map(x=>x.id==='write-S'?{...x,provenance:{...x.provenance,traceSha256:'x'}}:x)}),frozen).decision,'INVALID_ENVIRONMENT');
});
test('freshness/recovery/bridge/simple-reader gates',()=>{
  const timeout={backendMs:[...Array(999).fill(10),null],uiMs:Array(1000).fill(10)};
  assert.equal(decide({freshness:[timeout,timeout,timeout]}).reasons.simple.includes('freshness'),true);
  assert.equal(decide({freshness:[{backendMs:Array(999).fill(1),uiMs:Array(999).fill(1)}]}).decision,'INCONCLUSIVE');
  assert.equal(decide({recovery:[{outageSeconds:60,backlogEvents:300,catchUpSeconds:121,finalMismatches:0},{outageSeconds:60,backlogEvents:1,catchUpSeconds:1,finalMismatches:0},{outageSeconds:60,backlogEvents:1,catchUpSeconds:1,finalMismatches:0}]}).decision,'RECOMMEND_SIMPLE');
  assert.equal(decide({recovery:[{outageSeconds:60,backlogEvents:301,catchUpSeconds:1,finalMismatches:0}]}).decision,'INCONCLUSIVE');
  const bridge=decide({bridge:'NOT_RUN'});assert.equal(bridge.decision,'INCONCLUSIVE');assert.ok(bridge.reasons.inconclusive.includes('historical_bridge_required'));
  // C/S median 0.95 with fresh cache => C must be the preregistered L reader.
  const c=decide({p:{S:{S:200},C:{C:190},P:{P:100}}});assert.equal(c.gates.simpleReader.selected,'C');assert.equal(c.decision,'INCONCLUSIVE');
  assert.ok(c.reasons.inconclusive.includes('simple_reader_selection_mismatch'));
});
test('thresholds are read from the policy bytes, not hardcoded',()=>{
  const p=JSON.parse(frozen);p.primary.minimumRelativeP95Improvement=0.2;const relaxed=Buffer.from(JSON.stringify(p));
  assert.equal(decide(latency(250,250,190)).decision,'RECOMMEND_SIMPLE');// 0.76 vs locked 0.70
  assert.equal(evaluate(study({...latency(250,250,190),policy:relaxed}),relaxed).decision,'RECOMMEND_SUMMARY');
});
