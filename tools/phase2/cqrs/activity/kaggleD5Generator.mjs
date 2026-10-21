// Separate generator process for the D5 Kaggle readiness trial (its CPU is
// accounted as role 'generator'). Open-loop plan; every planned op keeps a raw
// outcome. Calibration targets a no-op sink outside the application.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {productPlan,runPlan,generatorValidity} from './bench/generator.mjs';

const spec=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.match(spec.run,/^[0-9a-f-]{36}$/);assert.ok(['calibration','smoke'].includes(spec.kind));
assert.equal(dirname(realpathSync(process.argv[2])),realpathSync(spec.directory));
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(spec.baseUrl));
const plan=productPlan(spec.plan),token=spec.token,candidates=spec.writeCandidates??[];let next=0;
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
async function execute(op){
  if(spec.kind==='calibration'){const r=await fetch(spec.baseUrl+'/noop',{signal:AbortSignal.timeout(10000)});await r.arrayBuffer();return {result:'success',status:r.status};}
  if(op.kind==='write'){
    // Valid admin lifecycle command through the public gateway (pending -> confirmed).
    const c=candidates[next++];if(!c)return {result:'error',error:'NO_WRITE_CANDIDATE'};
    const r=await fetch(spec.baseUrl+'/api/appointments/'+c.id+'/status',{method:'PATCH',headers,body:JSON.stringify({status:'confirmed',expectedRevision:c.statusRevision}),signal:AbortSignal.timeout(15000)});
    await r.arrayBuffer();return {result:'success',status:r.status,operation:'status'};
  }
  const sc=spec.scenarios[(op.screen+op.id)%spec.scenarios.length];
  const r=await fetch(spec.baseUrl+'/api/dashboard/clinic/activity?'+sc.q,{headers,signal:AbortSignal.timeout(15000)});
  const body=await r.json().catch(()=>({}));
  return {result:'success',status:r.status,scenario:sc.name,source:body.meta?.source,generation:body.meta?.generation??null,degraded:body.meta?.degraded,reason:body.meta?.reason,
    total:body.current?.total,header:{source:r.headers.get('x-clinic-read-source'),generation:r.headers.get('x-clinic-projection-generation')}};
}
const out=await runPlan(plan,execute,{maxInFlight:64,onRecord:rec=>appendFileSync(spec.rawFile,JSON.stringify({run:spec.run,label:spec.label,kind:spec.kind,...rec})+'\n')});
writeFileSync(spec.resultFile,JSON.stringify({label:spec.label,kind:spec.kind,originWallMs:out.originWallMs,plan:{...spec.plan,ops:plan.ops.length},validity:generatorValidity(plan,out.records),
  outcomes:out.records.reduce((m,r)=>{const k=r.outcome.result+':'+(r.outcome.status??'');m[k]=(m[k]??0)+1;return m;},{})},null,2),{mode:0o600});
