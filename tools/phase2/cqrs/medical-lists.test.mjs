import test from 'node:test';
import assert from 'node:assert/strict';
import {list} from '../../../services/clinic/dist/lists.js';

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

test('medical image compatibility retains scoped pagination and strips ownerId',async()=>{
  const image={id:'image',ownerId:actor.sub,petId:'pet-a',title:'Fixture',imageUrl:'data:image/png;base64,AA==',mimeType:'image/png',createdAt:new Date('2028-02-01')};
  const tx={medicalImage:{count:async({where})=>{assert.deepEqual(where,{ownerId:actor.sub});return 1;},findMany:async query=>{
    assert.deepEqual(query.orderBy,[{createdAt:'desc'},{id:'desc'}]);assert.equal(query.skip,0);assert.equal(query.take,20);return[image];
  }}};
  const db={$transaction:async(work,options)=>{assert.deepEqual(options,{isolationLevel:'RepeatableRead'});return work(tx);}};
  const result=await list(db,'medicalImages',actor,directory,{});
  assert.ok(!('ownerId' in result.items[0]));assert.equal(result.items[0].id,'image');assert.deepEqual(result.related.medicalImages,[]);
  assert.equal(result.pagination.total,1);assert.deepEqual(result.related.owners,[{id:actor.sub,fullName:'Fixture',directoryVersion:1}]);
});
