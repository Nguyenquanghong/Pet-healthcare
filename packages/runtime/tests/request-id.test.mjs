// Request/correlation ID propagation (observability). No DB/Redis/broker needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {acceptRequestId,withRequestId,eventCorrelation,currentRequestId,traceHeaders,ServiceRuntime} from '../dist/index.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('accepts canonical UUIDs and nginx $request_id; rejects anything else',()=>{
  const uuid=randomUUID(),nginx='0123456789abcdef0123456789ABCDEF';
  assert.equal(acceptRequestId(uuid),uuid);assert.equal(acceptRequestId(uuid.toUpperCase()),uuid.toUpperCase());
  assert.equal(acceptRequestId(nginx),nginx);
  assert.equal(acceptRequestId(uuid.replaceAll('-','')),uuid.replaceAll('-',''),'32 hex without dashes is the nginx form');
  for(const bad of ['-'.repeat(36),'0123456789abcdef0123456789abcde','g'.repeat(32),uuid+'\n',uuid.slice(0,35)+'-','x',undefined,null,42,[uuid]])
    assert.equal(acceptRequestId(bad),undefined,String(bad));
});

test('withRequestId scopes currentRequestId/traceHeaders across awaits; invalid IDs are replaced',async()=>{
  assert.equal(currentRequestId(),undefined);assert.deepEqual(traceHeaders(),{});
  const id=randomUUID();
  const seen=await withRequestId(id,async()=>{await new Promise(r=>setTimeout(r,5));return [currentRequestId(),traceHeaders()];});
  assert.deepEqual(seen,[id,{'X-Request-Id':id}]);
  const replaced=withRequestId('not-an-id',()=>currentRequestId());
  assert.match(replaced,UUID);assert.notEqual(replaced,'not-an-id');
  assert.equal(currentRequestId(),undefined);
});

test('eventCorrelation reads correlationId and tolerates malformed events',()=>{
  const id=randomUUID();
  assert.equal(eventCorrelation(JSON.stringify({eventId:'e',correlationId:id})),id);
  assert.equal(eventCorrelation('{not json'),undefined);assert.equal(eventCorrelation('null'),undefined);
});

test('HTTP middleware keeps a gateway ID, logs it, and propagates it to the next service call',async t=>{
  process.env.OBSERVABILITY_TOKEN='metrics-fixture-'.repeat(3);
  process.env.RATE_LIMIT_KEY_SECRET='limiter-fixture-'.repeat(3);
  process.env.REDIS_URL='redis://127.0.0.1:1';
  process.env.RATE_LIMIT_NAMESPACE='request-id-test';
  const logs=[],write=process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout,'write',(chunk,...rest)=>{const s=String(chunk);if(s.includes('"requestId"'))logs.push(JSON.parse(s));else write(chunk,...rest);return true;});
  // downstream service B echoes the ID it received; upstream A calls B with traceHeaders()
  const serve=async app=>{const server=app.listen(0,'127.0.0.1');await once(server,'listening');return server;};
  const b=express(),rb=new ServiceRuntime({service:'clinic',verify:()=>({sub:'s',role:'admin'})});rb.install(b);
  b.get('/probe',(_req,res)=>res.json({id:currentRequestId()}));
  const sb=await serve(b),bUrl='http://127.0.0.1:'+sb.address().port;
  const a=express(),ra=new ServiceRuntime({service:'core',verify:()=>({sub:'s',role:'admin'})});ra.install(a);
  a.get('/probe',async(_req,res)=>{const r=await fetch(bUrl+'/probe',{headers:traceHeaders()});res.json({id:currentRequestId(),downstream:(await r.json()).id});});
  const sa=await serve(a),aUrl='http://127.0.0.1:'+sa.address().port;
  t.after(()=>{sa.close();sb.close();for(const r of [ra,rb]){r.stopping=true;}});
  const nginx='abcdef0123456789abcdef0123456789';
  const res=await fetch(aUrl+'/probe',{headers:{'X-Request-Id':nginx}});
  assert.equal(res.headers.get('x-request-id'),nginx);
  assert.deepEqual(await res.json(),{id:nginx,downstream:nginx});
  const forged=await fetch(aUrl+'/probe',{headers:{'X-Request-Id':'<script>'}}),body=await forged.json();
  assert.match(body.id,UUID);assert.equal(body.downstream,body.id);
  // one access-log line per service with the gateway ID (route templates collapse unknown paths)
  assert.deepEqual(logs.filter(l=>l.requestId===nginx).map(l=>l.service).sort(),['clinic','core']);
  assert.ok(!logs.some(l=>JSON.stringify(l).includes('<script>')));
});
