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
