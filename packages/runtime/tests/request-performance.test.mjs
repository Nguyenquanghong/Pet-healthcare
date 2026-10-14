import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {requestActor,ServiceRuntime} from '../dist/index.js';

test('JWT result is bound to one request, token and verifier; forged req.auth is ignored',()=>{
  let calls=0;
  const verify=token=>{calls++;if(token==='bad')throw new Error('private reason');return{sub:token,role:'owner'};};
  const req={headers:{authorization:'Bearer owner-1'},auth:{sub:'forged',role:'admin'}};
  assert.deepEqual(requestActor(req,verify),{sub:'owner-1',role:'owner'});
  assert.deepEqual(requestActor(req,verify),{sub:'owner-1',role:'owner'});assert.equal(calls,1);
  assert.throws(()=>{requestActor(req,verify).role='admin';},TypeError);
  req.headers.authorization='Bearer owner-2';assert.equal(requestActor(req,verify).sub,'owner-2');assert.equal(calls,2);
  assert.throws(()=>requestActor(req,()=>{throw new Error('different issuer');}),/INVALID_ACTOR/);
  assert.equal(requestActor({headers:{authorization:'Bearer owner-2'}},verify).sub,'owner-2');assert.equal(calls,3);
  req.headers.authorization='Bearer bad';
  assert.throws(()=>requestActor(req,verify),/INVALID_ACTOR/);
  assert.throws(()=>requestActor(req,verify),/INVALID_ACTOR/);assert.equal(calls,4);
  assert.throws(()=>requestActor({headers:{authorization:'Bearer bad'}},verify));assert.equal(calls,5);
  for(const authorization of [undefined,'Basic anything','Bearer '+'x'.repeat(8193)])assert.throws(()=>requestActor({headers:{authorization}},verify));
  assert.equal(calls,5);
});

const snapshot=pending=>({pending,outboxAgeSeconds:0,outboxRetries:0,billingPending:0,billingAgeSeconds:0,dbLockWaits:0});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function runtime(probe){
  process.env.OBSERVABILITY_TOKEN='metrics-fixture-'.repeat(3);
  process.env.RATE_LIMIT_KEY_SECRET='limiter-fixture-'.repeat(3);
  process.env.REDIS_URL='redis://127.0.0.1:1';
  process.env.RATE_LIMIT_NAMESPACE='request-performance-test';
  const rt=new ServiceRuntime({service:'clinic',verify:()=>({sub:'owner',role:'owner'}),probe});
  rt.limiter.spend=async()=>({allowed:true,limit:100,remaining:99,retryMs:0});
  rt.limiter.ping=async()=>true;rt.brokerProbe=async()=>true;
  return rt;
}

test('writes do not await AMQP; stale, failed and over-limit snapshots still reject writes',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:10000});
  let probes=0,pending=0,dbFailed=false,release;
  const rt=runtime(async()=>{probes++;if(dbFailed)throw new Error('private-db');return snapshot(pending);});
  const app=express();rt.install(app);let written=0;
  app.post('/api/items',(_req,res)=>{written++;res.json({ok:true});});
  app.get('/api/items',(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const request=(method='POST')=>fetch(`http://127.0.0.1:${server.address().port}/api/items`,{method,signal:AbortSignal.timeout(1500)});
  let checking;
  try{
    assert.equal((await request()).status,503);assert.equal(written,0);assert.equal(probes,0);
    await rt.start();assert.equal(probes,1);assert.equal((await request()).status,200);assert.equal(probes,1);
    rt.brokerProbe=()=>new Promise(resolve=>{release=resolve;});
    checking=rt.refresh(true);await flush();assert.equal(probes,2);
    assert.equal((await request()).status,200,'fresh DB evidence allows write without waiting for the broker');
    t.mock.timers.tick(6001);await flush();
    assert.equal(probes,2,'in-flight refresh is shared, background checks never overlap');
    const stale=await request();assert.equal(stale.status,503);assert.equal(stale.headers.get('retry-after'),'2');assert.equal(written,2);
    release(true);await checking;checking=undefined;
    assert.equal((await request()).status,503,'late broker completion cannot refresh the old DB timestamp');
    rt.brokerProbe=async()=>true;await rt.refresh(true);assert.equal((await request()).status,200);
    pending=rt.hardLimit;await rt.refresh(true);const full=await request();assert.equal(full.status,503);assert.equal(full.headers.get('retry-after'),'5');
    pending=0;dbFailed=true;await rt.refresh(true);assert.equal((await request()).status,503);
    assert.equal((await request('GET')).status,200,'admission does not add a DB health dependency to reads');
    dbFailed=false;await rt.refresh(true);rt.limiter.spend=async()=>{throw new Error('Redis unavailable');};
    assert.equal((await request()).status,503,'Redis write policy stays fail closed');
  }finally{
    release?.(false);if(checking)await checking;
    rt.close();assert.equal(rt.refreshTimer,undefined);
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

test('background probe refreshes without traffic and stops on close',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:10000});
  let probes=0;const rt=runtime(async()=>{probes++;return snapshot(0);});
  try{
    await rt.start();assert.equal(probes,1);
    t.mock.timers.tick(3000);await flush();assert.equal(probes,2);
    t.mock.timers.tick(3000);await flush();assert.equal(probes,3);
    rt.close();t.mock.timers.tick(9000);await flush();assert.equal(probes,3);
  }finally{rt.close();}
});

test('shutdown waits for an in-flight background probe before disconnecting its database',async()=>{
  let release,disconnected=false;
  const rt=runtime(async()=>snapshot(0));await rt.start();
  rt.options.probe=()=>new Promise(resolve=>{release=resolve;});
  const checking=rt.refresh(true);await flush();
  const server={close:callback=>callback(),closeIdleConnections(){},closeAllConnections(){}};
  const draining=rt.drain(server,async()=>{disconnected=true;});
  await flush();assert.equal(disconnected,false);assert.equal(rt.refreshTimer,undefined);
  release(snapshot(0));await checking;await draining;assert.equal(disconnected,true);
});
