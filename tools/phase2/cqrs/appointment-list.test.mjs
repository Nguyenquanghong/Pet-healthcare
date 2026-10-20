import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {AuthoritativeAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/authoritativeAppointments.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {BusinessError} from '../../../services/clinic/dist/domain/error.js';

const runList=(db,actor,directory,raw)=>new AuthoritativeAppointmentQueries(db).list(actor,directory,raw);
const statuses=['pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'];
const actor={sub:'owner-a',role:'owner'},staff={sub:'staff',role:'staff'};
const ownerA={id:'owner-a',fullName:'Nguyễn An',directoryVersion:4};
const ownerB={id:'owner-b',fullName:'Owner B',directoryVersion:2};
const pets=[{id:'pet-a',ownerId:ownerA.id,name:'Mèo nhỏ',directoryVersion:4},{id:'pet-b',ownerId:ownerA.id,name:'Cún',directoryVersion:4},{id:'pet-c',ownerId:ownerB.id,name:'Mèo khác',directoryVersion:2}];
function appointment(id,status,type='general_checkup',petId='pet-a',date='2028-02-01',createdAt='2028-01-01'){
  const pet=pets.find(p=>p.id===petId);
  return{id,petId,ownerId:pet.ownerId,doctorId:null,type,serviceName:'Khám có dấu '+id,clinicName:'Fixture',appointmentDate:new Date(date),appointmentTime:'09:00',status,statusRevision:1,
    ownerNote:'Owner fixture',internalNote:'Private fixture',createdBy:'staff',createdAt:new Date(createdAt),updatedAt:new Date(createdAt),reservations:[]};
}
const rows=[
  appointment('a1','pending'),appointment('a2','pending','spa_bath','pet-a','2028-02-02','2028-01-02'),
  appointment('a3','confirmed'),appointment('a4','completed','spa_combo','pet-b'),
  {...appointment('a5','completed','general_checkup','pet-b'),reservations:[{state:'HELD'}]},
  {...appointment('a6','completed','general_checkup','pet-b'),reservations:[{state:'INVOICED'}]},
  appointment('a7','cancelled'),appointment('a8','no_show'),appointment('a9','in_progress'),
  appointment('b1','pending','spa_grooming','pet-c'),
];
const projections=[...pets.map(p=>({kind:'pet',id:p.id,ownerId:p.ownerId,displayName:p.name,deletedAt:null})),
  ...[ownerA,ownerB].map(o=>({kind:'owner',id:o.id,displayName:o.fullName,phone:'0900'+o.id,deletedAt:null})),
  {kind:'pet',id:'deleted-pet',displayName:'Mèo',deletedAt:new Date()}];
function matches(row,where){
  return Object.entries(where).every(([key,condition])=>{
    if(key==='AND')return condition.every(w=>matches(row,w));
    if(key==='OR')return condition.some(w=>matches(row,w));
    if(key==='reservations')return condition.some?row.reservations.some(r=>matches(r,condition.some)):!row.reservations.some(r=>matches(r,condition.none));
    const value=row[key];
    if(condition instanceof Date)return value?.getTime()===condition.getTime();
    if(condition&&typeof condition==='object'){
      if('in' in condition)return condition.in.includes(value);
      if('notIn' in condition)return !condition.notIn.includes(value);
      if('contains' in condition)return typeof value==='string'&&value.toLocaleLowerCase().includes(condition.contains.toLocaleLowerCase());
      throw new Error('Unsupported fixture predicate: '+key);
    }
    return value===condition;
  });
}
function fixture(input=rows){
  const calls=[],lookups=[];
  const tx={appointment:{
    groupBy:async query=>{calls.push(['groupBy',query]);const counts={};for(const row of input.filter(r=>matches(r,query.where)))counts[row.status]=(counts[row.status]??0)+1;return Object.entries(counts).map(([status,_count])=>({status,_count}));},
    count:async query=>{calls.push(['count',query]);return input.filter(r=>matches(r,query.where)).length;},
    findMany:async query=>{calls.push(['findMany',query]);return input.filter(r=>matches(r,query.where)).sort((a,b)=>{
      for(const order of query.orderBy){const [key,direction]=Object.entries(order)[0];const x=key==='status'?statuses.indexOf(a[key]):a[key],y=key==='status'?statuses.indexOf(b[key]):b[key];if(x<y)return direction==='asc'?-1:1;if(x>y)return direction==='asc'?1:-1;}return 0;
    }).slice(query.skip,query.skip+query.take).map(({reservations,...row})=>row);},
  },directoryProjection:{
    findMany:async query=>{calls.push(['directorySearch',query]);return projections.filter(row=>matches(row,query.where)).map(row=>Object.fromEntries(Object.keys(query.select).map(key=>[key,row[key]])));},
    findUnique:async query=>{calls.push(['directoryVersion',query]);return{sourceVersion:3,deletedAt:query.where.kind_id.id==='pet-c'?new Date():null};},
  }};
  const db={$transaction:async(work,options)=>{calls.push(['transaction',options]);return work(tx);}};
  const directory={lookup:async(petIds,ownerIds)=>{lookups.push({petIds,ownerIds});return{pets:pets.filter(p=>petIds.includes(p.id)),owners:[ownerA,ownerB].filter(o=>ownerIds.includes(o.id))};},pet:async id=>pets.find(p=>p.id===id)};
  return{db,calls,directory,lookups};
}
const ids=result=>result.items.map(row=>row.id);
const json=value=>JSON.parse(JSON.stringify(value));

test('list retains intersecting statuses, base counts, billingHeld and authoritative unbilled',async()=>{
  const matrix=[[{},9],[{statusGroup:'pending'},4],[{statusGroup:'cancelled'},2],[{status:'completed'},3],
    [{statusGroup:'pending',status:'confirmed'},1],[{statusGroup:'pending',status:'completed'},0]];
  for(const [raw,total] of matrix){
    const f=fixture(),result=await runList(f.db,actor,f.directory,raw);
    assert.equal(result.pagination.total,total);assert.deepEqual(result.counts,{pending:2,confirmed:1,completed:3,cancelled:1,no_show:1,in_progress:1,billingHeld:1});
    assert.deepEqual(f.calls[0],['transaction',{isolationLevel:'RepeatableRead'}]);
    assert.deepEqual(f.calls.slice(1).map(c=>c[0]),['groupBy','count','findMany']);
  }
  const f=fixture(),unbilled=await runList(f.db,staff,f.directory,{mode:'unbilled'});
  assert.deepEqual(ids(unbilled),['a4']);assert.equal(unbilled.pagination.total,1);
  // Preserve the current separate HELD count, which overrides the base reservation predicate.
  assert.deepEqual(unbilled.counts,{completed:1,billingHeld:1});
});

test('list preserves owner scope, explicit filters, Admin/Owner order and note redaction',async()=>{
  for(const [raw,expected] of [[{ownerId:'owner-b'},['a2','a1','a3','a9','a6','a5','a4','a7','a8']],
    [{petId:'pet-b'},['a6','a5','a4']],[{id:'b1'},[]],[{category:'spa'},['a2','a4']],
    [{date:'2028-02-02'},['a2']],[{category:'spa',date:'2028-02-01',status:'completed'},['a4']]]){
    const f=fixture(),result=await runList(f.db,actor,f.directory,raw);
    assert.deepEqual(ids(result),expected);assert.ok(result.items.every(row=>row.ownerId===actor.sub&&!('internalNote' in row)));
    assert.ok(result.related.owners.every(row=>row.id===actor.sub));
    assert.deepEqual(f.calls.find(c=>c[0]==='findMany')[1].orderBy,[{status:'asc'},{appointmentDate:'desc'},{appointmentTime:'desc'},{id:'desc'}]);
  }
  const f=fixture(),result=await runList(f.db,staff,f.directory,{});
  assert.deepEqual(ids(result),['a2','b1','a1','a3','a9','a6','a5','a4','a7','a8']);
  assert.ok(result.items.every(row=>row.internalNote==='Private fixture'));
  assert.deepEqual(f.calls.find(c=>c[0]==='findMany')[1].orderBy,[{status:'asc'},{createdAt:'desc'},{id:'desc'}]);
  assert.deepEqual(ids(await runList(f.db,staff,f.directory,{ownerId:'owner-b'})),['b1']);
});

test('search keeps directory predicates scoped, accents, metadata and related envelope',async()=>{
  for(const [raw,expected] of [[{q:'Mèo'},['a2','a1','a3','a9','a7','a8']],
    [{q:'Nguyễn'},['a2','a1','a3','a9','a6','a5','a4','a7','a8']],[{q:'có dấu',id:'a4'},['a4']],
    [{q:'Mèo khác'},[]],[{q:'unmatched'},[]]]){
    const f=fixture(),result=await runList(f.db,actor,f.directory,raw);assert.deepEqual(ids(result),expected);
    assert.equal(result.searchConsistency,'eventual');assert.equal(f.calls.filter(c=>c[0]==='directorySearch').length,2);
    assert.deepEqual(Object.keys(result.related).sort(),['owners','pets','appointments','medicalRecords','medicalImages','hotelBookings','dailyCareNotes','notifications','invoices'].sort());
    assert.deepEqual(result.related.appointments,[]);assert.deepEqual(result.related.medicalRecords,[]);assert.deepEqual(result.related.medicalImages,[]);
  }
  const f=fixture(),result=await runList(f.db,actor,f.directory,{petId:'pet-a',page:'2',pageSize:'100'});
  assert.deepEqual(result.items,[]);assert.deepEqual(result.related.owners,[]);assert.deepEqual(result.related.pets,[]);
  assert.deepEqual(result.directory,{petId:'pet-a',sourceVersion:4,projectionVersion:3,searchReady:false});
});

test('pagination keeps default 20, max 100, stable tie-breaks and empty pages',async()=>{
  const input=Array.from({length:105},(_,i)=>appointment('row-'+String(i).padStart(3,'0'),'pending'));
  for(const [raw,size,totalPages] of [[{},20,6],[{pageSize:'100'},100,2],[{page:'2',pageSize:'100'},5,2],[{page:'3',pageSize:'100'},0,2]]){
    const f=fixture(input),result=await runList(f.db,actor,f.directory,raw);
    assert.equal(result.items.length,size);assert.equal(result.pagination.total,105);assert.equal(result.pagination.totalPages,totalPages);
    if(size)assert.equal(result.items[0].id,raw.page==='2'?'row-004':'row-104');
    assert.ok(f.lookups.length<=1,'one Core lookup for the page');
  }
});

test('invalid filters reject before transaction; all/trim semantics stay compatible',async()=>{
  for(const raw of [{page:'0'},{page:'01'},{page:'1.5'},{pageSize:'101'},{pageSize:['20']},{q:'x'.repeat(101)},
    {id:2},{status:'missing'},{statusGroup:'missing'},{category:'alll'},{date:'2028-02-30'},{mode:'projection'}]){
    const f=fixture();await assert.rejects(runList(f.db,actor,f.directory,raw),error=>error.status===422);assert.equal(f.calls.length,0);
  }
  const f=fixture(),normal=await runList(f.db,actor,f.directory,{});
  assert.deepEqual(json(await runList(f.db,actor,f.directory,{status:'all',category:' all ',q:'   '})),json(normal));
  assert.deepEqual(ids(await runList(f.db,actor,f.directory,{id:' a1 '})),['a1']);
});

test('HTTP list preserves shape and does not query after Core authorization denial',async()=>{
  const f=fixture();let denied=false,authorizations=0;
  const source={request:async(a,_token,request,lookup=false)=>{
    if(denied)throw new BusinessError(403,'Owner or staff permission required.');
    if(!lookup)authorizations++;
    return{actor:{...a,fullName:'Fixture'},pets:pets.filter(p=>(request.petIds??[]).includes(p.id)),owners:[ownerA,ownerB].filter(o=>(request.ownerIds??[]).includes(o.id))};
  },acceptsService:()=>false};
  const server=createApp(f.db,()=>actor,source).listen(0,'127.0.0.1');await once(server,'listening');
  const get=()=>fetch(`http://127.0.0.1:${server.address().port}/api/appointments?statusGroup=pending&ownerId=owner-b`,{headers:{Authorization:'Bearer synthetic'},signal:AbortSignal.timeout(3000)});
  try{
    const response=await get();assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(ids(body),['a2','a1','a3','a9']);assert.equal(body.pagination.total,4);assert.equal(authorizations,1);
    assert.ok(body.items.every(row=>!('internalNote' in row)&&!('appointmentDate' in row)&&!('appointmentTime' in row)));
    assert.deepEqual(body.related.owners,[ownerA]);assert.deepEqual(body.related.appointments,[]);
    const before=f.calls.length;denied=true;assert.equal((await get()).status,403);assert.equal(f.calls.length,before);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
