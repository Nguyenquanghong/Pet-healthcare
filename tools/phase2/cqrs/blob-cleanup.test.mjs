import test from 'node:test';
import assert from 'node:assert/strict';
import {drainBlobCleanup} from '../../../services/clinic/dist/blobCleanup.js';

// AQ-09: objects of deleted images are removed by retry, never leaked, never double-failed.
function fakeDb(rows){
  return {rows,blobCleanup:{
    findMany:async({where,take})=>rows.filter(r=>r.nextAttemptAt<=where.nextAttemptAt.lte).slice(0,take),
    deleteMany:async({where})=>{const i=rows.findIndex(r=>r.storageKey===where.storageKey);if(i>=0)rows.splice(i,1);},
    update:async({where,data})=>{const r=rows.find(x=>x.storageKey===where.storageKey);r.attempts+=data.attempts.increment;r.nextAttemptAt=data.nextAttemptAt;}}};
}
const now=new Date('2030-01-01T00:00:00Z');
test('drain removes due objects and keeps failed ones with exponential backoff capped at one hour',async()=>{
  const db=fakeDb([{storageKey:'images/a',attempts:0,nextAttemptAt:now},{storageKey:'images/b',attempts:0,nextAttemptAt:now},{storageKey:'images/later',attempts:0,nextAttemptAt:new Date(now.getTime()+1000)},{storageKey:'images/worn',attempts:20,nextAttemptAt:now}]);
  const removed=[],blobs={remove:async key=>{if(key==='images/b'||key==='images/worn')throw new Error('down');removed.push(key);}};
  assert.deepEqual(await drainBlobCleanup(db,blobs,{now}),{due:3,removed:1});
  assert.deepEqual(removed,['images/a']);
  assert.deepEqual(db.rows.map(r=>[r.storageKey,r.attempts]),[['images/b',1],['images/later',0],['images/worn',21]]);
  assert.equal(db.rows[0].nextAttemptAt.getTime()-now.getTime(),30000);assert.equal(db.rows[2].nextAttemptAt.getTime()-now.getTime(),3600*1000);
  // After the backoff the failed object is retried and, once the bucket is back, removed.
  blobs.remove=async key=>{removed.push(key);};
  assert.deepEqual(await drainBlobCleanup(db,blobs,{now:new Date(now.getTime()+3601000)}),{due:3,removed:3});assert.deepEqual(db.rows,[]);
});
