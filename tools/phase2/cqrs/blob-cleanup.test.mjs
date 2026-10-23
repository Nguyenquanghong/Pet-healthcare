import test from 'node:test';
import assert from 'node:assert/strict';
import {drainBlobCleanup,imageRetentionMs} from '../../../services/clinic/dist/blobCleanup.js';

// AQ-09: objects of deleted images are removed by retry, never leaked, never double-failed;
// retention: a due claim purges the tombstone row (logged) before the object, and a
// restored image (live row) keeps its object.
function fakeDb(rows,images=[]){
  const log=[],events=[];
  const tx={
    $queryRaw:async(strings,...values)=>{const sql=strings.join('?'),[key]=values;return images.filter(i=>sql.includes('storage_key=?')?i.storageKey===key:i.id===key);},
    medicalImage:{delete:async({where})=>{events.push('row:'+where.id);images.splice(images.findIndex(i=>i.id===where.id),1);}},
    medicalImageDeletion:{create:async({data})=>{log.push(data);}},
  };
  return {rows,images,log,events,$transaction:async work=>work(tx),
    medicalImage:{findMany:async({where,take})=>images.filter(i=>i.storageKey===where.storageKey&&i.deletedAt&&i.deletedAt<=where.deletedAt.lte).slice(0,take)},
    blobCleanup:{
      findMany:async({where,take})=>rows.filter(r=>r.nextAttemptAt<=where.nextAttemptAt.lte).slice(0,take),
      deleteMany:async({where})=>{const i=rows.findIndex(r=>r.storageKey===where.storageKey);if(i>=0)rows.splice(i,1);},
      updateMany:async({where,data})=>{const r=rows.find(x=>x.storageKey===where.storageKey);if(r){r.attempts+=data.attempts.increment;r.nextAttemptAt=data.nextAttemptAt;}}}};
}
const now=new Date('2030-01-01T00:00:00Z');
test('drain removes due objects and keeps failed ones with exponential backoff capped at one hour',async()=>{
  const db=fakeDb([{storageKey:'images/a',attempts:0,nextAttemptAt:now},{storageKey:'images/b',attempts:0,nextAttemptAt:now},{storageKey:'images/later',attempts:0,nextAttemptAt:new Date(now.getTime()+1000)},{storageKey:'images/worn',attempts:20,nextAttemptAt:now}]);
  const removed=[],blobs={remove:async key=>{if(key==='images/b'||key==='images/worn')throw new Error('down');removed.push(key);}};
  assert.deepEqual(await drainBlobCleanup(db,blobs,{now}),{due:3,removed:1,purged:0});
  assert.deepEqual(removed,['images/a']);
  assert.deepEqual(db.rows.map(r=>[r.storageKey,r.attempts]),[['images/b',1],['images/later',0],['images/worn',21]]);
  assert.equal(db.rows[0].nextAttemptAt.getTime()-now.getTime(),30000);assert.equal(db.rows[2].nextAttemptAt.getTime()-now.getTime(),3600*1000);
  // After the backoff the failed object is retried and, once the bucket is back, removed.
  blobs.remove=async key=>{removed.push(key);};
  assert.deepEqual(await drainBlobCleanup(db,blobs,{now:new Date(now.getTime()+3601000)}),{due:3,removed:3,purged:0});assert.deepEqual(db.rows,[]);
});

test('retention: a due claim purges the logged tombstone first, a restored image keeps its object, legacy tombstones age out',async()=>{
  const image=(id,storageKey,deletedAt)=>({id,petId:'pet',ownerId:'owner',storageKey,sha256:storageKey?'a'.repeat(64):null,sizeBytes:storageKey?8:null,deletedAt});
  const old=new Date(now.getTime()-imageRetentionMs()),fresh=new Date(now.getTime()-1000);
  const db=fakeDb([{storageKey:'images/gone',attempts:0,nextAttemptAt:now},{storageKey:'images/restored',attempts:0,nextAttemptAt:now}],
    [image('gone','images/gone',old),image('restored','images/restored',null),image('legacy-old',null,old),image('legacy-fresh',null,fresh)]);
  const removed=[],blobs={remove:async key=>{db.events.push('object:'+key);removed.push(key);}};
  assert.deepEqual(await drainBlobCleanup(db,blobs,{now}),{due:2,removed:1,purged:2});
  assert.deepEqual(db.events,['row:gone','object:images/gone','row:legacy-old'],'row before object; the restored object is untouched');
  assert.deepEqual(db.images.map(i=>i.id),['restored','legacy-fresh']);
  assert.deepEqual(db.rows,[],'both claims are settled');
  assert.deepEqual(db.log.map(l=>[l.imageId,l.action,l.actorRole,l.storageKey]),[['gone','purge','system','images/gone'],['legacy-old','purge','system',null]]);
});
