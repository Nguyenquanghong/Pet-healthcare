import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {CoreDirectory} from '../../services/clinic/dist/directory.js';

// Clinic -> Core directory Circuit Breaker against real HTTP servers (no database).
const actor={sub:'owner-1',role:'owner'},credential='directory-breaker-fixture-'.padEnd(40,'x');
const snapshot={actor:{...actor,fullName:'Owner'},pets:[],owners:[]};

async function core(handler){
  const sockets=new Set(),server=createServer(handler);
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
function directory(url,failures,openMs){
  Object.assign(process.env,{CORE_DIRECTORY_BREAKER_FAILURES:String(failures),CORE_DIRECTORY_BREAKER_OPEN_MS:String(openMs)});
  try{return new CoreDirectory(url,credential);}finally{delete process.env.CORE_DIRECTORY_BREAKER_FAILURES;delete process.env.CORE_DIRECTORY_BREAKER_OPEN_MS;}
}
const timed=async work=>{const start=performance.now();try{await work();return {ms:performance.now()-start};}catch(error){return {ms:performance.now()-start,error};}};

test('a hung Core opens the circuit: later requests fail in milliseconds, a probe closes it after recovery',{timeout:30000},async()=>{
  let healthy=false;
  const server=await core((req,res)=>{if(healthy){res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshot));}});// hung: never answers
  try{
    const d=directory(server.url,2,500);
    for(let i=0;i<2;i++){const r=await timed(()=>d.request(actor,'token',{}));assert.equal(r.error?.status,503);assert.ok(r.ms>=1900,'timeout-bound before opening: '+r.ms);}
    assert.equal(d.breaker.state,'open');
    const fast=await timed(()=>d.request(actor,'token',{}));
    assert.equal(fast.error?.status,503);assert.match(fast.error.message,/Core directory unavailable/);assert.ok(fast.ms<100,'open circuit fails fast: '+fast.ms);
    healthy=true;await new Promise(r=>setTimeout(r,550));
    assert.deepEqual(await d.request(actor,'token',{}),snapshot);
    assert.equal(d.breaker.state,'closed');
  }finally{await server.close();}
});

test('business refusals keep the circuit closed; 5xx and terminal-evidence 5xx count as failures',{timeout:30000},async()=>{
  let status=403;
  const server=await core((req,res)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end('{}');});
  try{
    const d=directory(server.url,3,60000);
    for(let i=0;i<10;i++)await assert.rejects(d.request(actor,'token',{petIds:['p']}),error=>error.status===403);
    await assert.rejects(d.operationEvidence('op-1'),error=>error.status===503);// 403 evidence: Core answered
    assert.equal(d.breaker.state,'closed');
    status=500;
    for(let i=0;i<2;i++)await assert.rejects(d.request(actor,'token',{}),error=>error.status===503);
    await assert.rejects(d.operationEvidence('op-1'),error=>error.status===503);
    assert.equal(d.breaker.state,'open');
    await assert.rejects(d.operationEvidence('op-1'),/Reservation remains held/);
    assert.ok(d.breaker.counters.rejected>=1);
  }finally{await server.close();}
});
