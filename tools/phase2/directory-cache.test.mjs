import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestDirectory,CoreDirectory,DeferredDirectory,failClosed} from '../../services/clinic/dist/directory.js';
import {createApp} from '../../services/clinic/dist/app.js';
import {list} from '../../services/clinic/dist/lists.js';
import {requestActor} from '@nipopeto/runtime';
import {once} from 'node:events';
import {createServer} from 'node:http';
import express from 'express';

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

test('real Clinic HTTP path reuses medical snapshot; a list asks Core once after its query; JWT once per request',async()=>{
  const calls=[];let verified=0;
  const verify=()=>{verified++;return actor;};
  const appointment={id:'appointment',ownerId:'owner',petId:'one',type:'general_checkup',status:'pending',appointmentDate:new Date('2098-01-01'),appointmentTime:'09:00'};
  const record={id:'record',ownerId:'owner',petId:'one',appointmentId:null,visitDate:new Date('2026-01-01'),followUpDate:null,weightKg:null,temperatureC:null};
  const db={appointment:{groupBy:async()=>[{status:'pending',_count:1}],count:async()=>1,findMany:async()=>[appointment]},
    medicalRecord:{count:async()=>1,findMany:async()=>[record]},directoryProjection:{findUnique:async()=>({sourceVersion:1,deletedAt:null})},
    $transaction:async work=>Array.isArray(work)?Promise.all(work):work(db)};
  const source={request:async(a,token,ids,lookup=false)=>{calls.push({lookup,ids});return snapshot(ids.petIds.map(pet));},acceptsService:()=>false,breaker:{state:'closed'}};
  // Simulate the exact shared runtime authentication step before the router.
  const runtime={install:app=>app.use((req,_res,next)=>{requestActor(req,verify);next();})};
  const server=createApp(db,verify,source,runtime).listen(0,'127.0.0.1');await once(server,'listening');
  const get=path=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{Authorization:'Bearer synthetic'}});
  try{
    const medical=await get('/api/medical-records?petId=one');assert.equal(medical.status,200);
    const body=await medical.json();assert.equal(body.items[0].id,'record');assert.equal(body.related.pets[0].id,'one');
    assert.equal(calls.length,1);assert.equal(calls[0].lookup,false);assert.equal(verified,1);
    calls.length=0;const appointments=await get('/api/appointments');assert.equal(appointments.status,200);await appointments.json();
    assert.equal(calls.length,1,'authorization is deferred past the query and asked once');assert.deepEqual(calls,[{lookup:false,ids:{petIds:['one'],ownerIds:['owner']}}]);assert.equal(verified,2);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('appointment pagination total reuses status groups and preserves intersecting filters',async()=>{
  const counts={pending:5,confirmed:3,checked_in:2,in_progress:1,completed:7,cancelled:4,no_show:6};
  for(const [raw,total]of [[{},28],[{statusGroup:'pending'},11],[{statusGroup:'cancelled'},10],
    [{status:'completed'},7],[{statusGroup:'pending',status:'confirmed'},3],[{statusGroup:'pending',status:'completed'},0]]){
    let queries=0;
    const db={appointment:{groupBy:async()=>Object.entries(counts).map(([status,_count])=>({status,_count})),
      count:async({where})=>{queries++;assert.deepEqual(where.reservations,{some:{state:'HELD'}});return 2;},findMany:async()=>[]},
      $transaction:async(work,options)=>{transactions.push(options);return Array.isArray(work)?Promise.all(work):work(db);}};
    const transactions=[];
    const result=await list(db,'appointments',actor,{},raw);
    assert.equal(result.pagination.total,total);assert.equal(result.pagination.totalPages,Math.ceil(total/20));
    assert.deepEqual(result.counts,{...counts,billingHeld:2});assert.equal(queries,1,'only billing-held COUNT remains');assert.deepEqual(transactions,[{isolationLevel:'RepeatableRead'}],'one batch transaction, still RepeatableRead');
  }
});

// ---- B: deferred list authorization (one Core call per list GET) -------------------------------
const credential='deferred-directory-fixture-'.padEnd(40,'x');
async function fakeCore(){
  const state={mode:'ok',calls:[]},sockets=new Set();
  const server=createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      const body=JSON.parse(raw||'{}'),send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
      state.calls.push({path:req.url,body});
      if(state.mode==='revoked')return send(401,{error:'Password changed. Sign in again.',code:'SESSION_REVOKED'});
      if(state.mode==='forbidden')return send(403,{error:'Owner scope required.'});
      if(state.mode==='down')return send(503,{error:'Core directory unavailable.'});
      send(200,snapshot((body.petIds??[]).map(pet)));
    });
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return{state,url:'http://127.0.0.1:'+server.address().port,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
const directoryTo=(url,failures=5,openMs=5000)=>{
  Object.assign(process.env,{CORE_DIRECTORY_BREAKER_FAILURES:String(failures),CORE_DIRECTORY_BREAKER_OPEN_MS:String(openMs)});
  try{return new CoreDirectory(url,credential);}finally{delete process.env.CORE_DIRECTORY_BREAKER_FAILURES;delete process.env.CORE_DIRECTORY_BREAKER_OPEN_MS;}
};
const rowsOf={
  appointments:{id:'appointment',ownerId:'owner',petId:'one',type:'general_checkup',status:'pending',appointmentDate:new Date('2098-01-01'),appointmentTime:'09:00'},
  records:{id:'record',ownerId:'owner',petId:'one',appointmentId:null,visitDate:new Date('2026-01-01'),followUpDate:null,weightKg:null,temperatureC:null},
  images:{id:'image',ownerId:'owner',petId:'one',title:'Image',mimeType:'image/png',createdAt:new Date('2026-01-01'),storageKey:null,sizeBytes:1},
};
// A database double that records every call; `data` puts one row of that resource on the page.
function database({data,fail=false}={}){
  const touched=[],call=(name,value)=>async()=>{touched.push(name);if(fail)throw new Error('database down');return value;},has=name=>data===name;
  const db={touched,
    appointment:{groupBy:call('groupBy',has('appointments')?[{status:'pending',_count:1}]:[]),count:call('count',0),findMany:call('appointments',has('appointments')?[rowsOf.appointments]:[])},
    medicalRecord:{count:call('recordCount',has('records')?1:0),findMany:call('records',has('records')?[rowsOf.records]:[])},
    medicalImage:{count:call('imageCount',has('images')?1:0),findMany:call('images',has('images')?[rowsOf.images]:[])},
    directoryProjection:{findUnique:call('projection',{sourceVersion:1,deletedAt:null})},
    $transaction:async work=>Array.isArray(work)?Promise.all(work):work(db)};
  return db;
}
async function serve(db,source){
  const verify=()=>actor,runtime={install:app=>app.use((req,_res,next)=>{requestActor(req,verify);next();})};
  const server=createApp(db,verify,source,runtime).listen(0,'127.0.0.1');await once(server,'listening');
  return{get:(path,headers={})=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{Authorization:'Bearer synthetic',...headers}}),
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const routes=[{name:'appointments',path:'/api/appointments',data:'appointments'},{name:'medical-records',path:'/api/medical-records',data:'records'},{name:'medical-records/images',path:'/api/medical-records/images',data:'images'}];

test('a list GET asks Core once, after its query: routes x {empty, data, petId, 422, DB failure, version header}',async()=>{
  const core=await fakeCore(),source=directoryTo(core.url);
  const cases=[
    {name:'empty page',query:'',status:200,petIds:[],ownerIds:[]},
    {name:'data page',query:'',data:true,status:200,petIds:['one'],ownerIds:['owner']},
    {name:'petId, empty page',query:'?petId=one',status:200,petIds:['one'],ownerIds:[],pet:'one'},
    {name:'petId, data page (no duplicate pet)',query:'?petId=one',data:true,status:200,petIds:['one'],ownerIds:['owner'],pet:'one'},
    {name:'invalid pageSize (422 after Core agreed)',query:'?pageSize=0',status:422,petIds:[],ownerIds:[]},
    {name:'database failure (503 after Core agreed)',query:'',fail:true,status:503,petIds:[],ownerIds:[]},
    {name:'version header (only the appointment list reads it)',query:'',headers:{'x-clinic-min-version':'x'},status:route=>route.name==='appointments'?422:200,petIds:[],ownerIds:[]},
  ];
  try{
    for(const route of routes)for(const c of cases){
      core.state.mode='ok';core.state.calls.length=0;
      const db=database({data:c.data?route.data:undefined,fail:c.fail}),app=await serve(db,source);
      try{
        const res=await app.get(route.path+c.query,c.headers),body=await res.json(),label=route.name+': '+c.name;
        assert.equal(res.status,typeof c.status==='function'?c.status(route):c.status,label+' '+JSON.stringify(body));
        assert.equal(core.state.calls.length,1,label+': exactly one Core call');
        assert.deepEqual(core.state.calls[0],{path:'/internal/directory/authorize',body:{petIds:c.petIds,ownerIds:c.ownerIds}},label);
        if(res.status===200){
          if(c.data)assert.equal(body.related.pets[0].id,'one',label);
          if(c.pet)assert.equal(body.directory.petId,c.pet,label);
        }
      }finally{await app.close();}
    }
  }finally{await core.close();}
});

test('Core refusals win over every local outcome and no list leaves before Core answered: revoked 401, forbidden 403, down 503 + Retry-After',async()=>{
  const core=await fakeCore(),source=directoryTo(core.url,100);
  const outcomes=[
    {mode:'revoked',status:401,message:/password was changed/i},
    {mode:'forbidden',status:403,message:/permission required/i},
    {mode:'down',status:503,message:/Core directory unavailable|Retry/i,retryAfter:'1'},
  ];
  try{
    for(const route of routes)for(const outcome of outcomes)for(const local of [{name:'data page',data:true},{name:'empty page'},{name:'local 422',query:'?pageSize=0'},{name:'local database failure',fail:true},{name:'petId',query:'?petId=one'}]){
      core.state.mode=outcome.mode;core.state.calls.length=0;
      const db=database({data:local.data?route.data:undefined,fail:local.fail}),app=await serve(db,source);
      try{
        const res=await app.get(route.path+(local.query??'')),body=await res.json(),label=route.name+' '+outcome.mode+' + '+local.name;
        assert.equal(res.status,outcome.status,label+' '+JSON.stringify(body));
        assert.match(body.error,outcome.message,label);assert.equal(res.headers.get('retry-after'),outcome.retryAfter??null,label);
        assert.ok(!('items' in body)&&!('related' in body),label+': nothing from the query reaches the caller');
        assert.equal(core.state.calls.length,1,label+': memoized, one Core call');
      }finally{await app.close();}
    }
    // Eager routes (calendar, trailing slash) still ask Core before the database is touched.
    for(const path of ['/api/appointments/calendar?month=2098-01','/api/appointments/','/api/medical-records/']){
      core.state.mode='revoked';core.state.calls.length=0;
      const db=database(),app=await serve(db,source);
      try{assert.equal((await app.get(path)).status,401,path);assert.deepEqual(db.touched,[],path+': eager authorization touches no table');assert.equal(core.state.calls.length,1,path);}finally{await app.close();}
    }
  }finally{await core.close();}
});

test('breaker not closed: the eager path refuses before any table is read; once Core recovers the deferred path resumes',async()=>{
  const core=await fakeCore(),source=directoryTo(core.url,1,100);
  try{
    core.state.mode='down';
    const first=database(),a=await serve(first,source);
    try{
      assert.equal((await a.get('/api/appointments')).status,503);assert.ok(first.touched.length>0,'closed breaker: the query ran before Core refused');
      assert.equal(source.breaker.state,'open');core.state.calls.length=0;first.touched.length=0;
      for(const route of routes){const res=await a.get(route.path);assert.equal(res.status,503,route.name);assert.equal(res.headers.get('retry-after'),'1');await res.text();}
      assert.deepEqual(first.touched,[],'open breaker: no table touched');assert.equal(core.state.calls.length,0,'open breaker: no Core call');
      core.state.mode='ok';await new Promise(resolve=>setTimeout(resolve,150));
      assert.equal((await a.get('/api/appointments')).status,200,'the probe closes the breaker');assert.equal(source.breaker.state,'closed');
      core.state.calls.length=0;first.touched.length=0;
      assert.equal((await a.get('/api/appointments')).status,200);assert.equal(core.state.calls.length,1);assert.ok(first.touched.length>0);
    }finally{await a.close();}
  }finally{await core.close();}
});

test('DeferredDirectory: one memoized authorize covers the page; over 100 ids authorizes the initial pet, then looks up; a failure is memoized',async()=>{
  const calls=[],source={request:async(_actor,_token,ids,lookup=false)=>{calls.push({lookup,ids});return snapshot(ids.petIds.map(pet));}};
  const directory=new DeferredDirectory(source,actor,'token',['one']);
  assert.equal(directory.settled,false);
  assert.deepEqual((await directory.lookup(['one','two','two'],['owner'])).pets.map(p=>p.id),['one','two']);
  await directory.settle();await directory.pet('one');await directory.lookup(['two'],[]);
  assert.deepEqual(calls,[{lookup:false,ids:{petIds:['one','two'],ownerIds:['owner']}}]);assert.equal(directory.settled,true);
  const many=Array.from({length:100},(_,i)=>'p'+i),big=new DeferredDirectory(source,actor,'token',['one']);calls.length=0;
  assert.equal((await big.lookup(many,[])).pets.length,100);
  assert.deepEqual(calls.map(c=>[c.lookup,c.ids.petIds.length]),[[false,1],[true,100]],'authorize the initial pet, then lookup the page');
  const refused=new DeferredDirectory({request:async()=>{calls.push('refused');throw Object.assign(new Error('refused'),{status:403});}},actor,'token',[]);calls.length=0;
  await assert.rejects(refused.settle(),/refused/);await assert.rejects(refused.pet('one'),/refused/);await assert.rejects(refused.lookup(['one'],[]),/refused/);
  assert.deepEqual(calls,['refused']);assert.equal(refused.settled,false);
});

test('fail closed: a deferred route that answers before Core did becomes a 503; refusals and settled answers pass unchanged',async()=>{
  const core=await fakeCore(),source=directoryTo(core.url),directory=new DeferredDirectory(source,actor,'token',[]);
  const app=express();
  app.get('/leak',(_req,res)=>{failClosed(res,directory);res.json({secret:'rows'});});
  app.get('/refusal',(_req,res)=>{failClosed(res,directory);res.status(404).json({error:'not found'});});
  app.get('/settled',async(_req,res)=>{failClosed(res,directory);await directory.settle();res.json({ok:true});});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const get=path=>fetch(`http://127.0.0.1:${server.address().port}${path}`);
  try{
    const leak=await get('/leak'),text=await leak.text();
    assert.equal(leak.status,503);assert.equal(leak.headers.get('retry-after'),'1');assert.doesNotMatch(text,/rows/);assert.equal(core.state.calls.length,0,'the guard does not call Core itself');
    assert.equal((await get('/refusal')).status,404);
    const settled=await get('/settled');assert.equal(settled.status,200);assert.deepEqual(await settled.json(),{ok:true});
    assert.equal((await get('/leak')).status,200,'once settled the same directory may answer');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await core.close();}
});
