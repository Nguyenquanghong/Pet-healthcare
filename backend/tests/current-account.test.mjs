import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { currentAccount } from '../dist/src/phase2/currentAccount.js';
import { signToken } from '../dist/src/lib/token.js';

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
