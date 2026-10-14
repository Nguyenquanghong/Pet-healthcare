import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestDirectory} from '../../services/clinic/dist/directory.js';
import {createApp} from '../../services/clinic/dist/app.js';
import {list} from '../../services/clinic/dist/lists.js';
import {requestActor} from '@nipopeto/runtime';
import {once} from 'node:events';

const actor={sub:'owner',role:'owner'},owner={id:'owner',fullName:'Owner',directoryVersion:1};
const pet=id=>({id,ownerId:'owner',name:id,directoryVersion:1});
const snapshot=pets=>({actor:{...actor,fullName:'Owner'},pets,owners:[owner]});

test('directory reuses only request-authorized rows and asks Core for missing IDs',async()=>{
  const calls=[];
  const source={request:async(a,token,ids,lookup)=>{
    calls.push(ids);assert.equal(a,actor);assert.equal(token,'token');assert.equal(lookup,true);
    if(ids.ownerIds.includes('foreign'))throw new Error('Owner scope required');
    return snapshot(ids.petIds.map(pet));
  }};
  const directory=new RequestDirectory(source,actor,'token',snapshot([pet('one'),pet('unused')]));
  assert.deepEqual((await directory.lookup(['one','one'],['owner'])).pets,[pet('one')]);assert.equal(calls.length,0);
  assert.deepEqual((await directory.lookup(['one','two'],['owner'])).pets,[pet('one'),pet('two')]);
  assert.deepEqual(calls,[{petIds:['two'],ownerIds:[]}]);
  await directory.lookup(['two'],[]);assert.equal(calls.length,1);
  await assert.rejects(directory.lookup(['one'],['foreign']),/Owner scope/);
  const next=new RequestDirectory(source,actor,'token',snapshot([]));await next.lookup(['two'],['owner']);
  assert.equal(calls.length,3,'a new request cannot reuse a previous request snapshot');
  await assert.rejects(next.lookup(Array.from({length:101},(_,i)=>String(i)),[]),/Invalid directory IDs/);
});

test('real Clinic HTTP path reuses medical snapshot; list still resolves unknown pets; JWT once per request',async()=>{
  const calls=[];let verified=0;
  const verify=()=>{verified++;return actor;};
  const appointment={id:'appointment',ownerId:'owner',petId:'one',type:'general_checkup',status:'pending',appointmentDate:new Date('2098-01-01'),appointmentTime:'09:00'};
  const record={id:'record',ownerId:'owner',petId:'one',appointmentId:null,visitDate:new Date('2026-01-01'),followUpDate:null,weightKg:null,temperatureC:null};
  const db={appointment:{groupBy:async()=>[{status:'pending',_count:1}],count:async()=>1,findMany:async()=>[appointment]},
    medicalRecord:{count:async()=>1,findMany:async()=>[record]},directoryProjection:{findUnique:async()=>({sourceVersion:1,deletedAt:null})},
    $transaction:async work=>work(db)};
  const source={request:async(a,token,ids,lookup=false)=>{calls.push({lookup,ids});return snapshot(ids.petIds.map(pet));},acceptsService:()=>false};
  // Simulate the exact shared runtime authentication step before the router.
  const runtime={install:app=>app.use((req,_res,next)=>{requestActor(req,verify);next();})};
  const server=createApp(db,verify,source,runtime).listen(0,'127.0.0.1');await once(server,'listening');
  const get=path=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{Authorization:'Bearer synthetic'}});
  try{
    const medical=await get('/api/medical-records?petId=one');assert.equal(medical.status,200);
    const body=await medical.json();assert.equal(body.items[0].id,'record');assert.equal(body.related.pets[0].id,'one');
    assert.equal(calls.length,1);assert.equal(calls[0].lookup,false);assert.equal(verified,1);
    calls.length=0;const appointments=await get('/api/appointments');assert.equal(appointments.status,200);await appointments.json();
    assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.lookup),[false,true]);assert.equal(verified,2);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('appointment pagination total reuses status groups and preserves intersecting filters',async()=>{
  const counts={pending:5,confirmed:3,checked_in:2,in_progress:1,completed:7,cancelled:4,no_show:6};
  for(const [raw,total]of [[{},28],[{statusGroup:'pending'},11],[{statusGroup:'cancelled'},10],
    [{status:'completed'},7],[{statusGroup:'pending',status:'confirmed'},3],[{statusGroup:'pending',status:'completed'},0]]){
    let queries=0;
    const db={appointment:{groupBy:async()=>Object.entries(counts).map(([status,_count])=>({status,_count})),
      count:async({where})=>{queries++;assert.deepEqual(where.reservations,{some:{state:'HELD'}});return 2;},findMany:async()=>[]},
      $transaction:async work=>work(db)};
    const result=await list(db,'appointments',actor,{},raw);
    assert.equal(result.pagination.total,total);assert.equal(result.pagination.totalPages,Math.ceil(total/20));
    assert.deepEqual(result.counts,{...counts,billingHeld:2});assert.equal(queries,1,'only billing-held COUNT remains');
  }
});
