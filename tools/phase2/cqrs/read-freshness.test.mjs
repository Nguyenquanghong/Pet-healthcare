import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
test('freshness retains pending age across sampler errors and repeated source writes; clears only on catchup or generation change',async()=>{
 let now=10000,healthy=true,pending=1,generation='g';
 const tx={$executeRawUnsafe:async()=>0,readProjectionControl:{findUnique:async()=>({servingMode:'projection',activeGeneration:{id:generation,state:'ACTIVE',schemaVersion:1,verifiedAt:new Date(),projectionName:'appointments'}})},readRebuildRun:{count:async()=>0},$queryRaw:async()=>[{pending,oldest:new Date(now),bad:0}]};
 const f=new ReadFreshness({$transaction:fn=>fn(tx)},async()=>healthy,()=>now);
 await f.sample();assert.ok(f.usable('g'));now+=3000;healthy=false;await f.sample();assert.equal(f.evidence,undefined);
 now+=3000;healthy=true;await f.sample();assert.equal(f.evidence.lagMs,6000);assert.equal(f.usable('g'),false);
 pending=0;await f.sample();assert.ok(f.usable('g'));now+=6001;assert.equal(f.usable('g'),false);
 await f.sample();now-=1;assert.equal(f.usable('g'),false);now+=1;
 generation='next';await f.sample();assert.equal(f.usable('g'),false);assert.ok(f.usable('next'));await f.close();
});

test('freshness audits are single-flight with local serial execution and unchanged timeout, broker and lag guards',async()=>{
 let release,entered;const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 let probes=0,queries=0;const statements=[],options=[];
 const tx={$executeRawUnsafe:async sql=>statements.push(sql),readProjectionControl:{findUnique:async()=>({servingMode:'projection',activeGeneration:{id:'g',state:'ACTIVE',schemaVersion:1,verifiedAt:new Date(),projectionName:'appointments'}})},readRebuildRun:{count:async()=>0},$queryRaw:async sql=>{queries++;assert.match(sql.join(''),/FULL JOIN/);entered();await held;return [{pending:0,oldest:null,bad:0}];}};
 const f=new ReadFreshness({$transaction:(fn,opt)=>{options.push(opt);return fn(tx);}},async()=>{probes++;return true;},()=>10000);
 const one=f.sample();await ready;const two=f.sample();assert.equal(one,two);assert.equal(probes,1);release();await one;
 assert.equal(queries,1);assert.deepEqual(options,[{isolationLevel:'RepeatableRead',maxWait:50,timeout:1500}]);
 assert.deepEqual(statements,["SET LOCAL statement_timeout='750ms'",'SET LOCAL max_parallel_workers_per_gather=0']);assert.ok(f.usable('g'));
 await f.sample();assert.equal(queries,2);assert.equal(probes,2);await f.close();
});

// List study v2 K3v2-F1: list serving now uses the per-aggregate estimator.
function listScripted(steps){
 let i=-1;return {$transaction:async work=>{i++;const step=steps[i];let q=0;
  return work({$executeRawUnsafe:async()=>0,readRebuildRun:{count:async()=>0},
   readProjectionControl:{findUnique:async()=>({servingMode:'projection',activeGeneration:{id:'g',state:'ACTIVE',schemaVersion:1,verifiedAt:new Date(),projectionName:'appointments'}})},
   $queryRaw:async()=>{q++;const items=step.items;
    if(q===1)return [{pending:items.length,oldest:items.length?new Date(Math.min(...items.map(x=>x.changed))):null,bad:0}];
    return items.map(x=>({id:x.id,changed:new Date(x.changed),projected:x.projected}));}});}};
}
async function listRun(steps,options){
 let now=0;const f=new ReadFreshness(listScripted(steps),async()=>true,()=>now,undefined,options),out=[];
 for(const step of steps){now=step.at;await f.sample();out.push([f.evidence.lagMs,f.unusableReason('g')??'usable']);}
 return out;
}
test('list guard with per-aggregate lag stays usable under steady writes, still trips on a stuck aggregate',async()=>{
 // One write every 2s on a new aggregate, each projected within ~100ms: always one pending at sample time.
 const steady=Array.from({length:6},(_,k)=>({at:k*2000+100,items:[{id:'a'+k,changed:k*2000,projected:null}]}));
 assert.ok((await listRun(steady,{perAggregateLag:true})).every(([lag,r])=>lag===100&&r==='usable'));
 // The carried estimator (v1 behaviour) grows without bound and falls back after 5s.
 const carried=await listRun(steady);assert.equal(carried.at(-1)[0],10100);assert.equal(carried.at(-1)[1],'freshness_lag');
 // A genuinely stuck change is still guarded: same aggregate, same projected version.
 const stuck=await listRun(Array.from({length:4},(_,k)=>({at:k*2000+100,items:[{id:'x',changed:0,projected:1}]})),{perAggregateLag:true});
 assert.deepEqual(stuck.map(x=>x[1]),['usable','usable','usable','freshness_lag']);
});
test('createApp composes list serving with the per-aggregate estimator by default',async()=>{
 const {createApp}=await import('../../../services/clinic/dist/app.js');
 const saved={mode:process.env.CLINIC_READ_MODE,secret:process.env.CLINIC_READ_TOKEN_SECRET,projection:process.env.CLINIC_READ_PROJECTION};
 process.env.CLINIC_READ_MODE='projection';process.env.CLINIC_READ_PROJECTION='on';process.env.CLINIC_READ_TOKEN_SECRET='read-token-fixture-'.repeat(3);
 try{const app=createApp({});assert.equal(app.locals.appointmentServing.freshness.options.perAggregateLag,true);}
 finally{for(const [k,v] of [['CLINIC_READ_MODE',saved.mode],['CLINIC_READ_TOKEN_SECRET',saved.secret],['CLINIC_READ_PROJECTION',saved.projection]])v===undefined?delete process.env[k]:process.env[k]=v;}
});
test('service bootstrap passes the per-aggregate estimator to list serving (index.ts composition)',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../../../services/clinic/src/index.ts',import.meta.url),'utf8');
 const line=source.split('\n').find(l=>l.includes("CLINIC_READ_MODE==='projection')freshness=new ReadFreshness("));
 assert.ok(line&&/perAggregateLag:true/.test(line),line);
});
