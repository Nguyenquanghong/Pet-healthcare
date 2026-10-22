import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { currentAccount } from '../dist/src/phase2/currentAccount.js';
import { signToken, verifyToken } from '../dist/src/lib/token.js';
import { requireAuth } from '../dist/src/middleware/auth.js';
import { requestActor } from '@nipopeto/runtime';
import jwt from 'jsonwebtoken';

test('Core rejects deleted/changed actors, fails closed on DB outage, leaves public auth available', async () => {
  for(const key of ['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID'])delete process.env[key];
  process.env.JWT_SECRET=randomBytes(32).toString('hex');
  let account={id:'fixture',role:'admin'},calls=0,unavailable=false;
  const db={user:{findUnique:async query=>{calls++;assert.equal(query.where.id,'fixture');if(unavailable)throw new Error('private-database-address');return account;}}};
  const app=express();app.use('/api',currentAccount(db));app.use((_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const token=signToken('fixture','admin');
  const get=(path,credential=token)=>fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{headers:{Authorization:'Bearer '+credential}});
  try {
    assert.equal((await get('/owners')).status,200);
    account=null;assert.equal((await get('/owners')).status,401);
    assert.equal((await get('/auth/me')).status,401);
    account={id:'fixture',role:'owner'};assert.equal((await get('/owners')).status,403);
    unavailable=true;const failure=await get('/pets');assert.equal(failure.status,503);assert.doesNotMatch(await failure.text(),/private-database/);
    const before=calls;assert.equal((await get('/owners','invalid')).status,401);assert.equal(calls,before);
    for(const path of ['/auth/owner/login','/auth/admin/login','/auth/owner/register','/public/pets/fixture','/health','/payments/vnpay/ipn'])assert.equal((await get(path,'expired')).status,200);
    assert.equal(calls,before);
    assert.equal((await get('/payments/vnpay/reconcile')).status,503); // protected lookalike must not bypass
  } finally {await new Promise(ok=>server.close(ok));}
});

test('Core shares signature verification within a request but checks current account on every request',async()=>{
  for(const key of ['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID'])delete process.env[key];
  process.env.JWT_SECRET=randomBytes(32).toString('hex');
  const token=signToken('fixture','owner'),original=jwt.verify;let signatures=0,queries=0,account={id:'fixture',role:'owner'};
  jwt.verify=(...args)=>{signatures++;return original(...args);};
  const db={user:{findUnique:async()=>{queries++;return account;}}};
  const app=express();
  app.use((req,_res,next)=>{requestActor(req,verifyToken);next();});
  app.use('/api',currentAccount(db));app.use('/api',requireAuth);app.get('/api/pets',(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const get=()=>fetch(`http://127.0.0.1:${server.address().port}/api/pets`,{headers:{Authorization:'Bearer '+token}});
  try{
    assert.equal((await get()).status,200);assert.equal(signatures,1);assert.equal(queries,1);
    account={id:'fixture',role:'admin'};assert.equal((await get()).status,403);assert.equal(signatures,2);assert.equal(queries,2);
    account=null;assert.equal((await get()).status,401);assert.equal(signatures,3);assert.equal(queries,3);
  }finally{jwt.verify=original;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('AQ-05: tokens issued before the last password change are revoked; same-second and later tokens stay valid',async()=>{
  for(const key of ['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID'])delete process.env[key];
  process.env.JWT_SECRET=randomBytes(32).toString('hex');
  let account={id:'fixture',role:'owner',passwordChangedAt:null};
  const db={user:{findUnique:async query=>{assert.deepEqual(query.select,{id:true,role:true,passwordChangedAt:true});return account;}}};
  const app=express();app.use('/api',currentAccount(db));app.use((_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const at=seconds=>jwt.sign({role:'owner',iat:seconds},process.env.JWT_SECRET,{algorithm:'HS256',subject:'fixture',expiresIn:'1h'});
  const get=token=>fetch(`http://127.0.0.1:${server.address().port}/api/pets`,{headers:{Authorization:'Bearer '+token}});
  try{
    const now=Math.floor(Date.now()/1000),old=at(now-120);
    assert.equal((await get(old)).status,200,'no change recorded yet');
    account={...account,passwordChangedAt:new Date((now-60)*1000+500)};
    const revoked=await get(old);assert.equal(revoked.status,401);assert.match((await revoked.json()).error,/password was changed/);
    assert.equal((await get(at(now-60))).status,200,'issued in the same second as the change');
    assert.equal((await get(at(now))).status,200,'issued after the change');
  }finally{await new Promise(ok=>server.close(ok));}
});
