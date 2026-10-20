import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {AuthoritativeAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/authoritativeAppointments.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {BusinessError} from '../../../services/clinic/dist/domain/error.js';

const owner={sub:'owner-a',role:'owner'};
const runCalendar=(db,actor,query)=>new AuthoritativeAppointmentQueries(db).calendar(actor,query);
const appointments=[
  ['owner-a','2028-01-31','general_checkup'],
  ['owner-a','2028-02-01','general_checkup'],
  ['owner-a','2028-02-01','spa_bath'],
  ['owner-a','2028-02-01','spa_grooming'],
  ['owner-a','2028-02-29','spa_combo'],
  ['owner-a','2028-02-29','other'],
  ['owner-b','2028-02-01','vaccination'],
  ['owner-b','2028-02-29','spa_bath'],
  ['owner-a','2028-03-01','general_checkup'],
  ['owner-a','2028-12-31','other'],
  ['owner-a','2029-01-01','other'],
].map(([ownerId,date,type])=>({ownerId,appointmentDate:new Date(date+'T00:00:00Z'),type}));

function database(){
  const calls=[];
  const appointment=new Proxy({groupBy:async query=>{
    calls.push(query);
    assert.deepEqual(query.by,['appointmentDate']);assert.equal(query._count,true);
    // A read fixture has no writer, transaction, reservation or projection API.
    assert.deepEqual(Object.keys(query.where).sort(),query.where.type?['appointmentDate',...(query.where.ownerId?['ownerId']:[]),'type'].sort():['appointmentDate',...(query.where.ownerId?['ownerId']:[])].sort());
    const counts=new Map();
    for(const row of appointments){
      const where=query.where;
      if(where.ownerId&&where.ownerId!==row.ownerId)continue;
      if(row.appointmentDate<where.appointmentDate.gte||row.appointmentDate>=where.appointmentDate.lt)continue;
      if(where.type?.in&&!where.type.in.includes(row.type))continue;
      if(where.type?.notIn&&where.type.notIn.includes(row.type))continue;
      const day=row.appointmentDate.toISOString();counts.set(day,(counts.get(day)??0)+1);
    }
    return [...counts].map(([day,_count])=>({appointmentDate:new Date(day),_count}));
  }},{get(target,key){assert.ok(key in target,`Unexpected appointment operation: ${String(key)}`);return target[key];}});
  const db=new Proxy({appointment},{get(target,key){assert.ok(key in target,`Unexpected database operation: ${String(key)}`);return target[key];}});
  return{db,calls};
}

test('calendar retains owner scope, leap-day counts and medical/Spa categories',async()=>{
  const {db,calls}=database();
  assert.deepEqual(await runCalendar(db,owner,{month:'2028-02'}),{'2028-02-01':3,'2028-02-29':2});
  assert.deepEqual(await runCalendar(db,owner,{month:'2028-02',category:'medical'}),{'2028-02-01':1,'2028-02-29':1});
  assert.deepEqual(await runCalendar(db,owner,{month:'2028-02',category:'spa'}),{'2028-02-01':2,'2028-02-29':1});
  assert.equal(calls.length,3);assert.ok(calls.every(query=>query.where.ownerId===owner.sub));
  assert.equal(calls[0].where.appointmentDate.gte.toISOString(),'2028-02-01T00:00:00.000Z');
  assert.equal(calls[0].where.appointmentDate.lt.toISOString(),'2028-03-01T00:00:00.000Z');
});

test('calendar retains staff/doctor/admin scope, empty months and December boundary',async()=>{
  const {db,calls}=database();
  for(const role of ['staff','doctor','admin']){
    assert.deepEqual(await runCalendar(db,{sub:role,role},{month:'2028-02'}),{'2028-02-01':4,'2028-02-29':3});
  }
  assert.ok(calls.every(query=>!('ownerId' in query.where)));
  assert.deepEqual(await runCalendar(db,owner,{month:'2028-04'}),{});
  assert.deepEqual(await runCalendar(db,owner,{month:'2028-12'}),{'2028-12-31':1});
  assert.equal(calls.at(-1).where.appointmentDate.lt.toISOString(),'2029-01-01T00:00:00.000Z');
});

test('invalid month/category rejects with the existing 422 before a database query',async()=>{
  const {db,calls}=database();
  for(const month of [undefined,null,202802,'2028-2','2028-00','2028-13','0999-02',' 2028-02','2028-02-01',['2028-02']]){
    await assert.rejects(runCalendar(db,owner,{month}),error=>error.status===422&&error.message==='Invalid month or category.');
  }
  for(const category of ['all','SPA','',null,['spa','medical']]){
    await assert.rejects(runCalendar(db,owner,{month:'2028-02',category}),error=>error.status===422&&error.message==='Invalid month or category.');
  }
  assert.equal(calls.length,0);
});

test('calendar HTTP keeps JSON shape and Core authorization before scoped counts',async()=>{
  const {db,calls}=database();let denied=false;
  const authorizations=[];
  const verify=token=>{if(token==='owner')return owner;if(token==='staff')return{sub:'staff',role:'staff'};throw new Error('invalid token');};
  const source={request:async(actor,token,ids)=>{
    authorizations.push({actor,token,ids});
    if(denied)throw new BusinessError(403,'Owner or staff permission required.');
    return{actor:{...actor,fullName:'Fixture'},pets:[],owners:[]};
  },acceptsService:()=>false};
  const server=createApp(db,verify,source).listen(0,'127.0.0.1');await once(server,'listening');
  const get=(query,token='owner')=>fetch(`http://127.0.0.1:${server.address().port}/api/appointments/calendar?${query}`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(3000)});
  try{
    const response=await get('month=2028-02&category=spa&ownerId=owner-b');
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{'2028-02-01':2,'2028-02-29':1});
    assert.deepEqual(authorizations[0].ids,{petIds:[]});assert.equal(calls[0].where.ownerId,owner.sub);
    const staff=await get('month=2028-02','staff');assert.equal(staff.status,200);
    assert.deepEqual(await staff.json(),{'2028-02-01':4,'2028-02-29':3});
    const before=calls.length,authorized=authorizations.length;
    assert.equal((await get('month=2028-02','invalid')).status,401);
    assert.equal(authorizations.length,authorized);assert.equal(calls.length,before);
    denied=true;assert.equal((await get('month=2028-02')).status,403);assert.equal(calls.length,before);
    denied=false;const invalid=await get('month=2028-13');assert.equal(invalid.status,422);
    assert.deepEqual(await invalid.json(),{error:'Invalid month or category.'});assert.equal(calls.length,before);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Core/Clinic failure never becomes a successful calendar with zero counts',async()=>{
  let queries=0,coreUnavailable=true;
  const db={appointment:{groupBy:async()=>{queries++;throw new Error('private-database-address');}}};
  const source={request:async()=>{
    if(coreUnavailable)throw new BusinessError(503,'Core directory unavailable. Retry the same request key.');
    return{actor:{...owner,fullName:'Fixture'},pets:[],owners:[]};
  },acceptsService:()=>false};
  const server=createApp(db,()=>owner,source).listen(0,'127.0.0.1');await once(server,'listening');
  const get=()=>fetch(`http://127.0.0.1:${server.address().port}/api/appointments/calendar?month=2028-02`,{headers:{Authorization:'Bearer owner'},signal:AbortSignal.timeout(3000)});
  try{
    const core=await get();assert.equal(core.status,503);assert.deepEqual(await core.json(),{error:'Core directory unavailable. Retry the same request key.'});assert.equal(queries,0);
    coreUnavailable=false;const clinic=await get();assert.equal(clinic.status,503);
    assert.deepEqual(await clinic.json(),{error:'Clinic unavailable. Retry the same request key.'});assert.equal(queries,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
