// Activity study evaluator (S/C/P matched path blocks, P/L cost blocks, write
// supplement, freshness, recovery). Thresholds/semantics come ONLY from the
// frozen policy bytes passed in and their SHA256; nothing here is tunable.
// Decision precedence: FAIL_CORRECTNESS > INVALID_ENVIRONMENT > INCONCLUSIVE >
// RECOMMEND_SIMPLE | RECOMMEND_SUMMARY (policy.decisions).
import {createHash} from 'node:crypto';
import {nearestRank,generatorValidity} from './generator.mjs';

const median=v=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
// Inclusive policy bounds; tolerance only absorbs float division noise.
const le=(a,b)=>a<=b+1e-9,ge=(a,b)=>a>=b-1e-9;
const key=v=>JSON.stringify(v,Object.keys(v??{}).sort());
// Response classification against the configuration's expected path.
export function classify(run,rec){
  const o=rec.outcome??{},out={success:false,code:o.result??'missing'};
  if(o.result==='generatorDrop'||o.result==='timeout'||o.result==='error'){out.code=o.result;return out;}
  if(o.status===401||o.status===403)out.code='unexpected401or403';
  else if([422,429,503].includes(o.status))out.code=String(o.status);
  else if(o.status!==200&&o.status!==201)out.code='http_'+o.status;
  else if(rec.kind==='write')out.success=true,out.code='success';
  else{
    const allowed={S:['source'],C:['cached','source'],P:['summary'],L:run.simpleReader==='C'?['cached','source']:['source']}[run.label];
    if(run.label==='P'&&o.source==='source'&&o.degraded)out.code='fallback';
    else if(!allowed?.includes(o.source))out.code='wrongSource';
    else if(run.label==='P'&&o.generation!==run.expectedGeneration)out.code='wrongGeneration';
    else if(run.label!=='P'&&o.generation!==null&&o.generation!==undefined)out.code='wrongGeneration';
    else out.success=true,out.code='success';
  }
  return out;
}
function runStats(run){
  const counts={},primary=[],writes=[];let successes=0;
  for(const rec of run.records){if(!rec.measured)continue;const c=classify(run,rec);counts[c.code]=(counts[c.code]??0)+1;
    if(c.success){successes++;const latency=rec.completedMs-rec.scheduledMs;(rec.kind==='write'?writes:primary).push({latency,operation:rec.operation});}}
  const measuredSeconds=run.plan.measuredMs/1000,cpu=run.resource;
  return {id:run.id,label:run.label,kind:run.kind,block:run.block,counts,primarySuccesses:primary.length,writeSuccesses:writes.length,
    primaryP95Ms:nearestRank(primary.map(x=>x.latency),0.95),writeP95Ms:nearestRank(writes.map(x=>x.latency),0.95),writes,
    successfulThroughputPerSecond:successes/measuredSeconds,
    applicationCpuPerSuccess:cpu?.complete&&cpu.applicationCpuSeconds!=null&&successes?cpu.applicationCpuSeconds/successes:null,
    cpuCoverageComplete:Boolean(cpu?.complete&&cpu.applicationCpuSeconds!=null),validity:generatorValidity(run.plan,run.records)};
}

export function evaluate(input,policyBytes){
  const reasons={correctness:[],environment:[],inconclusive:[],simple:[]},gates={};
  const policy=JSON.parse(policyBytes),policySha=createHash('sha256').update(policyBytes).digest('hex');
  const pm=policy.primary,mx=policy.matrix,rg=policy.regression,fr=policy.freshness,rc=policy.recovery,pl=policy.productLoad;
  // Policy and provenance: graded only under a fully frozen policy that allows
  // measurement, with every run built from the same declared manifests.
  gates.policy={sha256:policySha,expected:input.policySha256,fullyFrozen:policy.fullyFrozen===true,performanceMeasurementsAllowed:policy.performanceMeasurementsAllowed===true};
  if(policySha!==input.policySha256)reasons.environment.push('policy_sha_mismatch');
  if(!gates.policy.fullyFrozen||!gates.policy.performanceMeasurementsAllowed)reasons.environment.push('policy_not_frozen_for_measurement');
  const provenanceKeys=['sourceTreeSha256','buildSha256','fixtureSha256','traceSha256','harnessSha256','policySha256'];
  for(const run of input.runs){
    if(provenanceKeys.some(k=>!/^[0-9a-f]{64}$/.test(run.provenance?.[k]??'')))reasons.environment.push('provenance_missing:'+run.id);
    else if(run.provenance.policySha256!==policySha)reasons.environment.push('run_policy_mismatch:'+run.id);
  }
  const profiles=new Set(input.runs.map(r=>key({...r.profileKey,provenance:r.provenance})));
  gates.profileStrata=profiles.size;if(profiles.size!==1)reasons.inconclusive.push('profile_key_strata_differ');
  // Replacement: only an objectively invalid-environment run may be replaced once.
  const slots=new Map();for(const run of input.runs){const slot=run.kind+':'+run.block+':'+run.label;(slots.get(slot)??slots.set(slot,[]).get(slot)).push(run);}
  const graded=[],stats=new Map();
  for(const [slot,runs] of slots){
    if(runs.length>2)reasons.inconclusive.push('too_many_replacements:'+slot);
    let chosen;for(const run of runs){const s=runStats(run);stats.set(run.id,s);if(s.validity.valid&&!chosen)chosen=run;}
    if(!chosen){reasons.environment.push((runs.length>1?'second_environmental_invalidity:':'generator_invalid:')+slot);continue;}
    if(runs[0]!==chosen&&!runs[0].environmentalInvalidity)reasons.inconclusive.push('replacement_of_non_environmental_run:'+slot);
    graded.push(chosen);
  }
  const S=id=>stats.get(id);
  // Correctness/outcomes: healthy runs allow zero unexpected outcomes of any kind.
  for(const run of graded){const c=S(run.id).counts;for(const [code,n] of Object.entries(c))if(code!=='success'&&n>0)
    (['generatorDrop'].includes(code)?reasons.environment:reasons.correctness).push(`${code}:${run.id}:${n}`);}
  const cc=input.correctness??{};for(const k of Object.keys(policy.correctness).filter(k=>typeof policy.correctness[k]==='number'))
    if(!(cc[k]===policy.correctness[k]))reasons.correctness.push('correctness:'+k);
  // Matrix completeness in the preregistered order.
  const at=(kind,block,label)=>graded.find(r=>r.kind===kind&&r.block===block&&r.label===label);
  mx.pathBlocks.forEach((order,b)=>{const runs=order.map(l=>at('path',b,l));if(runs.some(r=>!r))reasons.inconclusive.push('incomplete_path_block:'+b);
    else if(runs.map(r=>r.position).join()!==order.map((_,i)=>i).join())reasons.inconclusive.push('path_block_order:'+b);});
  for(const run of graded.filter(r=>r.kind==='path'))if(S(run.id).primarySuccesses<pm.minimumSuccessfulSamplesPerRun)reasons.inconclusive.push('insufficient_primary_samples:'+run.id);
  // Primary benefit of P over each simple baseline, per matched block.
  const blocks=mx.pathBlocks.map((_,b)=>({P:at('path',b,'P'),S:at('path',b,'S'),C:at('path',b,'C')})).filter(x=>x.P&&x.S&&x.C);
  gates.primary={pMaxP95Ms:pm.maximumP95Ms,perBlock:blocks.map(x=>({P:S(x.P.id).primaryP95Ms,S:S(x.S.id).primaryP95Ms,C:S(x.C.id).primaryP95Ms}))};
  let benefit=blocks.length===mx.pathBlocks.length;
  if(blocks.some(x=>!le(S(x.P.id).primaryP95Ms,pm.maximumP95Ms)))benefit=false,reasons.simple.push('p_p95_above_max');
  for(const base of pm.compareAgainst){
    const ratios=blocks.map(x=>S(x.P.id).primaryP95Ms/S(x[base].id).primaryP95Ms),savings=blocks.map(x=>S(x[base].id).primaryP95Ms-S(x.P.id).primaryP95Ms);
    const g={medianRatio:median(ratios),medianSavingMs:median(savings),worstRatio:ratios.length?Math.max(...ratios):null};gates.primary['vs'+base]=g;
    if(!le(g.medianRatio,1-pm.minimumRelativeP95Improvement))benefit=false,reasons.simple.push('relative_improvement_vs_'+base);
    if(!ge(g.medianSavingMs,pm.minimumAbsoluteP95ImprovementMs))benefit=false,reasons.simple.push('absolute_saving_vs_'+base);
    if(!le(g.worstRatio,1+pm.maximumPairedRunRegression))benefit=false,reasons.simple.push('paired_regression_vs_'+base);
  }
  gates.primary.benefit=benefit;
  // Simple reader for L: preregistered rule, must match what L actually ran.
  const cs=blocks.map(x=>S(x.C.id).primaryP95Ms/S(x.S.id).primaryP95Ms);
  const cacheEligible=input.cacheFreshnessPass===true&&le(median(cs),0.95)&&cs.every(r=>le(r,1.1));
  gates.simpleReader={medianCOverS:median(cs),selected:cacheEligible?'C':'S',declared:input.selectedSimpleReader};
  if(gates.simpleReader.declared!==gates.simpleReader.selected)reasons.inconclusive.push('simple_reader_selection_mismatch');
  // Total cost P vs L (matched cost blocks) + pooled/supplement writes.
  let cost='PASS';const pairs=mx.totalCostBlocksAfterPathBlocks.map((_,b)=>({P:at('cost',b,'P'),L:at('cost',b,'L')}));
  gates.totalCost={pairs:[]};
  for(const [b,x] of pairs.entries()){
    if(!x.P||!x.L){cost='INCONCLUSIVE';reasons.inconclusive.push('incomplete_cost_block:'+b);continue;}
    const p=S(x.P.id),l=S(x.L.id);
    if(!p.cpuCoverageComplete||!l.cpuCoverageComplete){cost='INCONCLUSIVE';reasons.inconclusive.push('TOTAL_COST_INCONCLUSIVE:cpu_coverage:'+b);}
    const pair={cpuPerSuccessRatio:p.applicationCpuPerSuccess&&l.applicationCpuPerSuccess?p.applicationCpuPerSuccess/l.applicationCpuPerSuccess:null,
      throughputRatio:p.successfulThroughputPerSecond/l.successfulThroughputPerSecond,writeP95Ratio:p.writeP95Ms!=null&&l.writeP95Ms!=null?p.writeP95Ms/l.writeP95Ms:null};
    gates.totalCost.pairs.push(pair);
    if(pair.cpuPerSuccessRatio!=null&&!le(pair.cpuPerSuccessRatio,1+rg.maximumApplicationCpuPerSuccessIncrease)&&cost!=='INCONCLUSIVE')cost='FAIL';
    if(!ge(pair.throughputRatio,1-rg.maximumSuccessfulThroughputDecrease))cost=cost==='INCONCLUSIVE'?cost:'FAIL';
    if(pair.writeP95Ratio!=null&&!le(pair.writeP95Ratio,1+rg.maximumWriteP95Increase))cost=cost==='INCONCLUSIVE'?cost:'FAIL';
  }
  const supplement=label=>graded.filter(r=>r.kind==='write'&&r.label===label);
  for(const label of ['P','L']){
    // Product cost-block P/L writes + supplement = planned 1040/configuration;
    // >=1000 pooled and >=200 per operation (20/20/60 mix), else extend/inconclusive.
    const pooledRuns=[...graded.filter(r=>r.kind==='cost'&&r.label===label),...supplement(label)],per={};
    const pooled=pooledRuns.reduce((n,r)=>n+S(r.id).writeSuccesses,0);for(const r of pooledRuns)for(const w of S(r.id).writes)per[w.operation]=(per[w.operation]??0)+1;
    if(pooled<rg.minimumMeasuredWriteSamplesPerConfiguration){cost=cost==='FAIL'?cost:'INCONCLUSIVE';reasons.inconclusive.push('insufficient_writes:'+label);}
    if(Object.keys(pl.writeMix).some(op=>(per[op]??0)<rg.writeSupplement.minimumEachOperationSamples)){cost=cost==='FAIL'?cost:'INCONCLUSIVE';reasons.inconclusive.push('insufficient_operation_samples:'+label);}
  }
  const sp=supplement('P'),sl=supplement('L');
  if(sp.length&&sl.length){const ratio=nearestRank(sp.flatMap(r=>S(r.id).writes.map(w=>w.latency)),0.95)/nearestRank(sl.flatMap(r=>S(r.id).writes.map(w=>w.latency)),0.95);
    gates.totalCost.supplementWriteP95Ratio=ratio;if(!le(ratio,1+rg.maximumWriteP95Increase)&&cost==='PASS')cost='FAIL';}
  else{cost=cost==='FAIL'?cost:'INCONCLUSIVE';reasons.inconclusive.push('write_supplement_missing');}
  gates.totalCost.result=cost;if(cost==='FAIL')reasons.simple.push('total_cost_regression');
  // Freshness and recovery (timeouts are right-censored: Infinity).
  const f=input.freshness?.runs??[];let fresh='PASS';
  if(f.length<fr.runs)fresh='INCONCLUSIVE';
  gates.freshness=f.map(run=>{const b=run.backendMs.map(v=>v==null?Infinity:v),u=run.uiMs.map(v=>v==null?Infinity:v);
    const g={samples:b.length,backendP95:nearestRank(b,0.95),backendP99:nearestRank(b,0.99),uiP95:nearestRank(u,0.95),timeouts:b.filter(v=>v===Infinity).length+u.filter(v=>v===Infinity).length};
    if(b.length<fr.minimumSamplesPerRun||u.length<fr.minimumSamplesPerRun)fresh=fresh==='FAIL'?fresh:'INCONCLUSIVE';
    else if(g.timeouts||!le(g.backendP95,fr.backendP95Ms)||!le(g.backendP99,fr.backendP99Ms)||!le(g.uiP95,fr.visibleUiP95Ms))fresh='FAIL';return g;});
  const r=input.recovery?.runs??[];let recovery=r.length>=rc.runs?'PASS':'INCONCLUSIVE';
  for(const run of r){if(run.outageSeconds<rc.outageSeconds||run.backlogEvents>rc.maximumBacklogEvents)recovery=recovery==='FAIL'?recovery:'INCONCLUSIVE';
    else if(!(run.catchUpSeconds<=rc.maximumCatchUpSeconds)||run.finalMismatches!==rc.requiredFinalMismatchCount)recovery='FAIL';}
  gates.freshnessResult=fresh;gates.recoveryResult=recovery;
  if(fresh==='FAIL')reasons.simple.push('freshness');if(recovery==='FAIL')reasons.simple.push('recovery');
  if(fresh==='INCONCLUSIVE')reasons.inconclusive.push('freshness_insufficient');if(recovery==='INCONCLUSIVE')reasons.inconclusive.push('recovery_insufficient');
  // Whole-system claim needs the historical bridge (ADR-activity-03).
  gates.historicalBridge=input.historicalBridge?.status??'NOT_RUN';
  let decision;
  if(reasons.correctness.length)decision='FAIL_CORRECTNESS';
  else if(reasons.environment.length)decision='INVALID_ENVIRONMENT';
  else if(reasons.simple.length&&!reasons.inconclusive.some(x=>x.startsWith('incomplete')||x.startsWith('insufficient_primary')||x==='profile_key_strata_differ'))decision='RECOMMEND_SIMPLE';
  else if(reasons.inconclusive.length)decision='INCONCLUSIVE';
  else if(gates.historicalBridge!=='PASS'){decision='INCONCLUSIVE';reasons.inconclusive.push('historical_bridge_required');}
  else decision='RECOMMEND_SUMMARY';
  return {format:'clinic-activity-evaluation-v1',decision,reasons,gates,runs:[...stats.values()].map(({writes,...s})=>s)};
}
