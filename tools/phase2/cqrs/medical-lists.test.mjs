import test from 'node:test';
import assert from 'node:assert/strict';
import {list} from '../../../services/clinic/dist/infrastructure/queries/authoritativeLists.js';

const actor={sub:'owner-a',role:'owner'};
const directory={lookup:async()=>({pets:[{id:'pet-a',ownerId:actor.sub,name:'Fixture',directoryVersion:1}],owners:[{id:actor.sub,fullName:'Fixture',directoryVersion:1}]})};

test('medical list compatibility preserves owner scope and redacts records and linked appointments',async()=>{
  const row={id:'record',ownerId:actor.sub,petId:'pet-a',appointmentId:'appointment',visitDate:new Date('2028-02-01'),followUpDate:null,weightKg:'12.34',temperatureC:'38.5',internalNote:'Private record'};
  const appointment={id:'appointment',ownerId:actor.sub,petId:'pet-a',appointmentDate:new Date('2028-02-01'),appointmentTime:'09:00',internalNote:'Private appointment'};
  const tx={medicalRecord:{count:async({where})=>{assert.deepEqual(where,{ownerId:actor.sub});return 1;},findMany:async()=>[row]},
    appointment:{findMany:async({where})=>{assert.deepEqual(where,{id:{in:['appointment']},ownerId:actor.sub});return[appointment];}}};
  const db={$transaction:async(work,options)=>{assert.deepEqual(options,{isolationLevel:'RepeatableRead'});return work(tx);}};
  const result=await list(db,'medicalRecords',actor,directory,{ownerId:'owner-b'});
  assert.equal(result.items[0].visitDate,'2028-02-01');assert.equal(result.items[0].weightKg,12.34);
  assert.ok(!('internalNote' in result.items[0]));assert.ok(!('internalNote' in result.related.appointments[0]));
  assert.deepEqual(result.related.medicalRecords,[]);assert.equal(result.pagination.total,1);assert.deepEqual(result.counts,{});
});

test('medical image list retains scoped pagination, signs a valet key per stored image and exposes no storage fields',async()=>{
  const image={id:'image',ownerId:actor.sub,petId:'pet-a',title:'Fixture',imageUrl:null,storageKey:'images/image',sizeBytes:8,sha256:'a'.repeat(64),mimeType:'image/png',createdAt:new Date('2028-02-01')};
  const blobs={signedGetUrl:key=>({url:'https://blob.test/'+key,expiresAt:new Date('2028-02-01T00:05:00Z')})};
  const tx={medicalImage:{count:async({where})=>{assert.deepEqual(where,{deletedAt:null,ownerId:actor.sub});return 1;},findMany:async query=>{
    assert.deepEqual(query.orderBy,[{createdAt:'desc'},{id:'desc'}]);assert.equal(query.skip,0);assert.equal(query.take,20);return[image];
  }}};
  const db={$transaction:async(work,options)=>{assert.deepEqual(options,{isolationLevel:'RepeatableRead'});return work(tx);}};
  const result=await list(db,'medicalImages',actor,directory,{},blobs);
  assert.deepEqual(Object.keys(result.items[0]).sort(),['createdAt','id','mimeType','petId','sizeBytes','title','url','urlExpiresAt']);
  assert.equal(result.items[0].url,'https://blob.test/images/image');assert.equal(result.items[0].sizeBytes,8);assert.deepEqual(result.related.medicalImages,[]);
  assert.equal(result.pagination.total,1);assert.deepEqual(result.related.owners,[{id:actor.sub,fullName:'Fixture',directoryVersion:1}]);
});

test('legacy base64 rows list without content or URL; stored rows fail closed when no bucket is configured',async()=>{
  const row=over=>({id:'image',ownerId:actor.sub,petId:'pet-a',title:'Fixture',imageUrl:'data:image/png;base64,AA==',storageKey:null,sizeBytes:null,sha256:null,mimeType:'image/png',createdAt:new Date('2028-02-01'),...over});
  const db=rows=>({$transaction:async work=>work({medicalImage:{count:async()=>rows.length,findMany:async()=>rows}})});
  const legacy=await list(db([row({})]),'medicalImages',actor,directory,{});
  assert.deepEqual(legacy.items[0],{id:'image',petId:'pet-a',title:'Fixture',mimeType:'image/png',createdAt:new Date('2028-02-01'),sizeBytes:null,url:null,urlExpiresAt:null});
  await assert.rejects(list(db([row({imageUrl:null,storageKey:'images/image',sizeBytes:8})]),'medicalImages',actor,directory,{}),error=>error.status===503);
});
