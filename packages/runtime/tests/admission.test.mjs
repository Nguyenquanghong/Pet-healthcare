import test from 'node:test';
import assert from 'node:assert/strict';
import { Admission, AdmissionError, publicVerifier } from '../dist/index.js';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('bounded hashes reserve running slots and hand queued work off without exceeding concurrency',async()=>{
  const gate=new Admission(2,1,1000),a=deferred(),b=deferred();let queuedRuns=0;
  const first=gate.run(()=>a.promise),second=gate.run(()=>b.promise),third=gate.run(async()=>{queuedRuns++;return 3;});
  await assert.rejects(gate.run(async()=>4),AdmissionError);assert.equal(gate.stats.active,2);assert.equal(gate.stats.queued,1);assert.equal(queuedRuns,0);
  a.resolve(1);assert.equal(await first,1);assert.equal(await third,3);b.resolve(2);await second;assert.equal(gate.stats.active,0);assert.equal(gate.stats.peakActive,2);assert.equal(gate.stats.peakQueued,1);
});
test('queue deadline cancels only queued work and never frees a running hash slot',async()=>{
  const gate=new Admission(1,1,25),hold=deferred();let ran=false;const running=gate.run(()=>hold.promise);
  await assert.rejects(gate.run(async()=>{ran=true;}),AdmissionError);assert.equal(ran,false);assert.equal(gate.stats.active,1);assert.equal(gate.stats.queued,0);
  hold.resolve();await running;assert.equal(gate.stats.active,0);
});
test('closing admission rejects pending work, retains running work and prevents a new hash',async()=>{
  const gate=new Admission(1,2,1000),hold=deferred();const running=gate.run(()=>hold.promise),pending=gate.run(async()=>1);
  gate.close();await assert.rejects(pending,AdmissionError);await assert.rejects(gate.run(async()=>2),AdmissionError);assert.equal(gate.stats.active,1);hold.resolve();await running;
});
test('verifier rejects algorithm, issuer, audience, kid, role, expiry and malformed subject',()=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  const verify=publicVerifier({publicKey,issuer:'test-core',audience:'pet-api',keyId:'test-1'});
  const sign=(body={role:'owner'},{algorithm='RS256',issuer='test-core',audience='pet-api',keyid='test-1',subject='owner-id',expiresIn='1h'}={})=>jwt.sign(body,algorithm==='HS256'?'long-fixture-hmac-key-for-test-only':keys.privateKey,{algorithm,issuer,audience,keyid,subject,expiresIn});
  assert.deepEqual(verify(sign()),{sub:'owner-id',role:'owner'});
  for(const token of [sign(undefined,{algorithm:'HS256'}),sign(undefined,{issuer:'wrong'}),sign(undefined,{audience:'wrong'}),sign(undefined,{keyid:'wrong'}),sign({role:'superuser'}),sign(undefined,{expiresIn:-1}),sign(undefined,{subject:''}),sign(undefined,{subject:'x'.repeat(201)})])assert.throws(()=>verify(token));
});
