// Graceful drain: a keep-alive client must not hold a stopping service until SHUTDOWN_TIMEOUT_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {ServiceRuntime} from '../dist/index.js';

const DEADLINE_MS=4000,PROMPT_MS=2000;
async function service(t){
  process.env.OBSERVABILITY_TOKEN='metrics-fixture-'.repeat(3);
  process.env.RATE_LIMIT_KEY_SECRET='limiter-fixture-'.repeat(3);
  process.env.REDIS_URL='redis://127.0.0.1:1';
  process.env.RATE_LIMIT_NAMESPACE='drain-test';
  process.env.SHUTDOWN_TIMEOUT_MS=String(DEADLINE_MS);
  let entered,release;const started=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;});
  const app=express(),rt=new ServiceRuntime({service:'clinic',verify:()=>({sub:'s',role:'admin'})});rt.install(app);
  app.get('/slow',async(_req,res)=>{entered();await held;res.json({ok:true});});
  const server=app.listen(0,'127.0.0.1');server.keepAliveTimeout=60000;await once(server,'listening');
  const agent=new http.Agent({keepAlive:true,maxSockets:1}),port=server.address().port;
  t.after(()=>{agent.destroy();server.closeAllConnections();rt.close();delete process.env.SHUTDOWN_TIMEOUT_MS;});
  const get=path=>new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path,agent},res=>{res.resume();res.once('end',()=>resolve({status:res.statusCode,connection:res.headers.connection}));}).once('error',reject);
  });
  return {rt,server,get,started,release};
}
const prompt=draining=>Promise.race([draining.then(()=>true),sleep(PROMPT_MS).then(()=>false)]);

test('a client polling on the connection of an in-flight request does not stretch the drain to the deadline',async t=>{
  const {rt,server,get,started,release}=await service(t);
  const slow=get('/slow');await started;
  const draining=rt.drain(server,async()=>{});
  release();assert.equal((await slow).status,200,'the request in flight when the drain began still completes');
  let polling=true;const refused=[];
  const poller=(async()=>{while(polling){try{refused.push(await get('/next'));}catch{return;}await sleep(20);}})();
  const finished=await prompt(draining);polling=false;await poller;
  assert.equal(finished,true,'drain must not wait for SHUTDOWN_TIMEOUT_MS');
  assert.ok(refused.length>0,'the poller reached the draining service');
  for(const response of refused)assert.deepEqual(response,{status:503,connection:'close'});
});

test('a client that goes quiet after its in-flight request does not stretch the drain either',async t=>{
  const {rt,server,get,started,release}=await service(t);
  const slow=get('/slow');await started;
  const draining=rt.drain(server,async()=>{});
  release();assert.equal((await slow).status,200);
  assert.equal(await prompt(draining),true,'drain must not wait for SHUTDOWN_TIMEOUT_MS');
});
