import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcnDataset} from './pcn_dataset.mjs';

test('PCN fixture matches phase-1 row counts and QR capability across the three stores',async()=>{
  const rows={};
  const table=name=>({create:async({data})=>{(rows[name]??=[]).push(data);return data;}});
  const db={core:Object.fromEntries(['user','pet','hotelBooking','invoice'].map(n=>[n,table(n)])),
    clinic:Object.fromEntries(['appointment','medicalRecord'].map(n=>[n,table(n)])),
    notification:{notification:table('notification')}};
  const result=await createPcnDataset(db,{run:'synthetic-run',hash:{passwordHash:'fake',passwordSalt:'fake'},count:100});
  for(const name of ['user','pet','hotelBooking','invoice','appointment','medicalRecord','notification'])assert.equal(rows[name].length,100,name);
  assert.equal(result.accounts.length,100);
  assert.equal(new Set(rows.pet.map(p=>p.qrToken)).size,100);
  for(let i=0;i<100;i++){
    const pet=rows.pet[i];assert.equal(pet.qrEnabled,true);
    assert.equal(rows.appointment[i].petId,pet.id);assert.equal(rows.medicalRecord[i].ownerId,pet.ownerId);
    assert.equal(rows.notification[i].recipientOwnerId,pet.ownerId);
    assert.equal(result.accounts[i].pets[0].qrToken,pet.qrToken);
    assert.equal(rows.invoice[i].hotelBookingId,rows.hotelBooking[i].id);
    assert.equal(rows.invoice[i].items.create.amount,200000);
  }
});
test('PCN fixture rejects an unbounded population before database writes',async()=>{
  for(const count of [1,101,Infinity,NaN,2.5])await assert.rejects(createPcnDataset({}, {count}),/PCN_ACCOUNT_COUNT/);
});
