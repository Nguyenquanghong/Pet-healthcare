import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appointmentRows,createQueryDataset} from './query_dataset.mjs';

test('100k fixture has unique owner slots, broad distributions, stable dates and marked private fields',()=>{
  const ids=new Set(),slots=new Set(),statuses=new Set(),types=new Set(),days=new Set();
  for(let owner=0;owner<100;owner++)for(const row of appointmentRows('owner-'+owner,'pet-'+owner,owner)){
    const slot=[row.petId,row.appointmentDate.toISOString(),row.appointmentTime].join(':');
    assert.ok(!ids.has(row.id)&&!slots.has(slot));ids.add(row.id);slots.add(slot);
    statuses.add(row.status);types.add(row.type);days.add(row.appointmentDate.toISOString());
    assert.equal(row.ownerId,'owner-'+owner);assert.equal(row.internalNote,'QUERY_PRIVATE');
  }
  assert.equal(ids.size,100000);assert.equal(statuses.size,7);assert.equal(types.size,10);assert.equal(days.size,21);
});
test('dataset rejects wrong account count before any database access',async()=>{
  await assert.rejects(createQueryDataset({}, {count:40}),/exactly 100/);
});
