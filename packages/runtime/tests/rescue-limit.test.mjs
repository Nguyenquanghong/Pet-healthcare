import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {ServiceRuntime} from '../dist/index.js';

// AQ-01 / E-b: public rescue reports get their own IP and per-token buckets.
const snapshot={pending:0,outboxAgeSeconds:0,outboxRetries:0,billingPending:0,billingAgeSeconds:0,dbLockWaits:0};
async function harness(t,env={}){
  Object.assign(process.env,{OBSERVABILITY_TOKEN:'metrics-fixture-'.repeat(3),RATE_LIMIT_KEY_SECRET:'limiter-fixture-'.repeat(3),
    REDIS_URL:'redis://127.0.0.1:1',RATE_LIMIT_NAMESPACE:'rescue-limit-test'},env);
  t.after(()=>{for(const key of Object.keys(env))delete process.env[key];});
  const rt=new ServiceRuntime({service:'core',verify:()=>({sub:'owner',role:'owner'}),probe:async()=>snapshot});
  const spent=[];
  // localRead has the same check-all-then-increment semantics as the Redis script.
  rt.limiter.spend=async(group,buckets)=>{spent.push({group,buckets});return rt.limiter.localRead(group,buckets);};
  rt.limiter.ping=async()=>true;rt.brokerProbe=async()=>true;await rt.start();
  const app=express();rt.install(app);let reports=0;
  app.post('/api/public/pets/:token/rescue-reports',(_req,res)=>{reports++;res.status(201).json({ok:true});});
  app.post('/api/pets',(_req,res)=>res.status(201).json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{rt.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const post=path=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',signal:AbortSignal.timeout(1500)});
  return {post,spent,count:()=>reports};
}

test('per-token bucket rejects a flood against one pet with 429 before the handler runs',async t=>{
  const {post,spent,count}=await harness(t);
  for(let i=0;i<5;i++)assert.equal((await post('/api/public/pets/tok-a/rescue-reports')).status,201);
  const denied=await post('/api/public/pets/tok-a/rescue-reports');
  assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>=1);assert.equal(denied.headers.get('ratelimit-limit'),'5');
  assert.equal(count(),5,'denied report never reaches the handler');
  assert.equal((await post('/api/public/pets/tok-b/rescue-reports')).status,201,'another pet keeps its own budget');
  assert.equal((await post('/api/public/pets/%74ok-a/rescue-reports')).status,429,'percent-encoded token shares the decoded bucket');
  const policy=spent.at(-1);assert.equal(policy.group,'public-rescue');
  assert.deepEqual(policy.buckets.map(b=>[b.identity.split(':')[0],b.limit,b.windowMs]),[['ip',20,900000],['rescue-token',5,900000],['rescue-token-day',20,86400000]]);
});

test('IP bucket caps one client across many tokens; thresholds come from env',async t=>{
  const {post,count}=await harness(t,{RESCUE_REPORT_IP_LIMIT:'3',RESCUE_REPORT_TOKEN_LIMIT:'50'});
  for(let i=0;i<3;i++)assert.equal((await post(`/api/public/pets/ip-${i}/rescue-reports`)).status,201);
  assert.equal((await post('/api/public/pets/ip-9/rescue-reports')).status,429);assert.equal(count(),3);
  assert.equal((await post('/api/pets')).status,201,'other writes keep the general write policy');
});

test('invalid threshold configuration fails closed instead of disabling the limiter',async t=>{
  const {post,count}=await harness(t,{RESCUE_REPORT_TOKEN_LIMIT:'0'});
  assert.equal((await post('/api/public/pets/tok-a/rescue-reports')).status,503);assert.equal(count(),0);
});

test('daily per-token bucket caps a slow flood that stays under the 15-minute bucket',async t=>{
  const {post,count}=await harness(t,{RESCUE_REPORT_TOKEN_LIMIT:'50',RESCUE_REPORT_IP_LIMIT:'50',RESCUE_REPORT_TOKEN_DAILY_LIMIT:'3'});
  for(let i=0;i<3;i++)assert.equal((await post('/api/public/pets/tok-day/rescue-reports')).status,201);
  const denied=await post('/api/public/pets/tok-day/rescue-reports');
  assert.equal(denied.status,429);assert.ok(Number(denied.headers.get('retry-after'))>0);assert.equal(count(),3);
  assert.equal((await post('/api/public/pets/tok-other/rescue-reports')).status,201,'another pet keeps its own daily budget');
});
