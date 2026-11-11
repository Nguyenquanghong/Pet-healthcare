import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcnDataset,MAX_ACCOUNTS} from './pcn_dataset.mjs';

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
  for(const count of [1,801,Infinity,NaN,2.5])await assert.rejects(createPcnDataset({}, {count}),/PCN_ACCOUNT_COUNT/);
});
test('PCN fixture holds 800 owners, each with an account and a calendar slot of its own, and refuses 801',async()=>{
  assert.equal(MAX_ACCOUNTS,800);
  const rows={};
  const table=name=>({create:async({data})=>{(rows[name]??=[]).push(data);return data;}});
  const db={core:Object.fromEntries(['user','pet','hotelBooking','invoice'].map(n=>[n,table(n)])),
    clinic:Object.fromEntries(['appointment','medicalRecord'].map(n=>[n,table(n)])),
    notification:{notification:table('notification')}};
  const result=await createPcnDataset(db,{run:'synthetic-run',hash:{passwordHash:'fake',passwordSalt:'fake'},count:800});
  for(const name of ['user','pet','hotelBooking','invoice','appointment','medicalRecord','notification'])assert.equal(rows[name].length,800,name);
  assert.equal(result.accounts.length,800);
  assert.equal(result.description.accounts,800);
  // One login per owner: the per-actor limits (600 reads, 120 writes a minute) are never shared between users.
  assert.equal(new Set(rows.user.map(u=>u.email)).size,800);
  assert.equal(new Set(rows.pet.map(p=>p.qrToken)).size,800);
  // The visit grid: one 30-minute slot of 08:00-17:00 per owner, 19 a day, so no slot is taken twice and none is over capacity.
  const slots=rows.appointment.map(a=>a.appointmentDate.toISOString().slice(0,10)+' '+a.appointmentTime);
  assert.equal(new Set(slots).size,800);
  const times=[...new Set(rows.appointment.map(a=>a.appointmentTime))].sort();
  assert.equal(times.length,19);assert.equal(times[0],'08:00');assert.equal(times.at(-1),'17:00');
  const days=new Set(rows.appointment.map(a=>a.appointmentDate.toISOString().slice(0,10)));
  assert.equal(days.size,43);
  assert.ok([...days].every(d=>d>='2098-01-01'&&d<'2099-01-01'),'visits stay before the 2099 grid the load books on');
  // The stays: one night each, at most 5 on a night (10 standard rooms), all before 2099.
  const perNight={};
  for(const h of rows.hotelBooking){const night=h.checkIn.toISOString().slice(0,10);perNight[night]=(perNight[night]??0)+1;assert.equal(h.checkOut-h.checkIn,86400000);assert.ok(night<'2099-01-01');}
  assert.equal(Object.keys(perNight).length,160);
  assert.equal(Math.max(...Object.values(perNight)),5);
  await assert.rejects(createPcnDataset({},{count:801}),/PCN_ACCOUNT_COUNT/);
});
