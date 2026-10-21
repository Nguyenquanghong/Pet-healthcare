// Open-loop activity load generator and the generator-validity rule locked in
// evidence/benchmark-plan-20261021.json (generatorValidity). It never adapts the
// arrival rate to the application; every planned operation keeps an outcome.
import {performance} from 'node:perf_hooks';

// Nearest-rank percentile (policy measurementProtocol.percentile). Non-finite
// values (timeouts, right-censored) stay in the population and sort last.
export function nearestRank(values,p){
  if(!(p>0&&p<=1))throw new Error('INVALID_PERCENTILE');
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(p*sorted.length)-1];
}
function rng(seed){let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}

// Product load (acceptance productLoad): N staggered screens polling the primary
// endpoint every pollMs, plus open-loop writes at a fixed mean rate and mix.
// Offsets are ms from the run origin; measured = scheduled inside the window.
export function productPlan({screens=10,pollMs=15000,warmupMs=120000,measuredMs=1800000,writesPerSecond=0.1,writeMix={create:0.2,reschedule:0.2,status:0.6},seed=20261020}={}){
  if(!Number.isInteger(screens)||screens<1||!(pollMs>0)||!(warmupMs>=0)||!(measuredMs>0)||!(writesPerSecond>=0))throw new Error('INVALID_PLAN');
  const mixTotal=Object.values(writeMix).reduce((a,b)=>a+b,0);if(Math.abs(mixTotal-1)>1e-9)throw new Error('INVALID_WRITE_MIX');
  const end=warmupMs+measuredMs,ops=[],random=rng(seed);
  for(let s=0;s<screens;s++)for(let t=Math.round(s*pollMs/screens);t<end;t+=pollMs)ops.push({kind:'read',operation:'primary',screen:s,offsetMs:t});
  if(writesPerSecond>0){const gap=1000/writesPerSecond,kinds=Object.entries(writeMix);
    for(let i=0,t=gap/2;t<end;i++,t+=gap){let at=random(),kind=kinds.at(-1)[0];for(const [k,w] of kinds){at-=w;if(at<0){kind=k;break;}}ops.push({kind:'write',operation:kind,index:i,offsetMs:Math.round(t)});}}
  ops.sort((a,b)=>a.offsetMs-b.offsetMs||(a.kind<b.kind?-1:1));
  return {format:'clinic-activity-open-loop-plan-v1',screens,pollMs,warmupMs,measuredMs,writesPerSecond,writeMix,seed,
    ops:ops.map((o,id)=>({id,...o,measured:o.offsetMs>=warmupMs&&o.offsetMs<end}))};
}

// Dispatch every planned op at origin+offset regardless of completions. When the
// in-flight cap is reached the op is recorded as a generator drop (never delayed
// or silently skipped). execute(op) resolves to an outcome object.
export async function runPlan(plan,execute,{maxInFlight=64,now=()=>performance.now(),wall=()=>Date.now(),timeoutMs=30000,onRecord}={}){
  const origin=now()+50,wallOrigin=wall()+50,records=[];let inFlight=0;
  await new Promise(resolve=>{
    let pending=plan.ops.length,i=0;if(!pending){resolve();return;}
    const finish=()=>{if(--pending===0)resolve();};
    const tick=()=>{
      const elapsed=now()-origin;
      while(i<plan.ops.length&&plan.ops[i].offsetMs<=elapsed){
        const op=plan.ops[i++],dispatchedMs=now()-origin,rec={id:op.id,kind:op.kind,operation:op.operation,measured:op.measured,scheduledMs:op.offsetMs,dispatchedMs,completedMs:null,outcome:null};
        records.push(rec);
        if(inFlight>=maxInFlight){rec.outcome={result:'generatorDrop'};rec.completedMs=dispatchedMs;onRecord?.(rec);finish();continue;}
        inFlight++;
        let timer;const timeout=new Promise(r=>{timer=setTimeout(()=>r({result:'timeout'}),timeoutMs);});
        Promise.race([Promise.resolve().then(()=>execute(op)).catch(error=>({result:'error',error:String(error?.code??error?.name??'ERROR').slice(0,80)})),timeout])
          .then(outcome=>{clearTimeout(timer);rec.completedMs=now()-origin;rec.outcome=outcome;inFlight--;onRecord?.(rec);finish();});
      }
      if(i<plan.ops.length)setTimeout(tick,Math.max(0,Math.min(20,plan.ops[i].offsetMs-(now()-origin)-1)));
    };
    tick();
  });
  return {originWallMs:wallOrigin,records};
}

// benchmark-plan generatorValidity: zero drops for healthy acceptance, dispatch
// lateness p99<=100ms and max<=1000ms, >=99% of planned measured ops dispatched
// inside the measured window, complete timestamps. Invalid => do not grade.
export const lockedValidity={maximumGeneratorDrops:0,dispatchLatenessP99MaxMs:100,dispatchLatenessMaxMs:1000,minimumPlannedDispatchFractionInsideMeasuredWindow:0.99};
export function generatorValidity(plan,records,rule=lockedValidity){
  const reasons=[],measured=records.filter(r=>r.measured);
  const planned=plan.ops.filter(o=>o.measured).length;
  if(records.length!==plan.ops.length)reasons.push('planned_count_mismatch');
  if(records.some(r=>![r.scheduledMs,r.dispatchedMs,r.completedMs].every(Number.isFinite)||!r.outcome))reasons.push('missing_timestamps_or_outcome');
  const drops=records.filter(r=>r.outcome?.result==='generatorDrop').length;if(drops>rule.maximumGeneratorDrops)reasons.push('generator_drops');
  const lateness=measured.map(r=>r.dispatchedMs-r.scheduledMs);
  const p99=nearestRank(lateness,0.99),max=lateness.length?Math.max(...lateness):null;
  if(p99===null||p99>rule.dispatchLatenessP99MaxMs)reasons.push('dispatch_lateness_p99');
  if(max===null||max>rule.dispatchLatenessMaxMs)reasons.push('dispatch_lateness_max');
  const end=plan.warmupMs+plan.measuredMs,inside=measured.filter(r=>r.dispatchedMs>=plan.warmupMs&&r.dispatchedMs<end).length;
  const fraction=planned?inside/planned:0;if(fraction<rule.minimumPlannedDispatchFractionInsideMeasuredWindow)reasons.push('dispatch_fraction_inside_window');
  return {valid:reasons.length===0,reasons,planned,recorded:records.length,drops,latenessP99Ms:p99,latenessMaxMs:max,insideFraction:fraction};
}
