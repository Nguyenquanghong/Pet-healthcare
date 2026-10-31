import test from 'node:test';
import assert from 'node:assert/strict';
import {appointmentRoutes} from '../../services/clinic/dist/http/routes/appointments.js';
import {medicalRecordRoutes} from '../../services/clinic/dist/http/routes/medicalRecords.js';
import {dashboardRoutes} from '../../services/clinic/dist/http/routes/dashboard.js';
import {assertRoutes,mountRoutes} from '../../services/clinic/dist/http/scope.js';
import {clinicRouteLabel} from '../../services/clinic/dist/http/routeLabel.js';
import {DeferredDirectory,RequestDirectory} from '../../services/clinic/dist/infrastructure/core/directory.js';

// The route registry of Clinic's HTTP layer (services/clinic/src/http/routes): what each route declares, what startup
// refuses, and that every route has a metric label. Needs `npm run phase2:build`, no Docker. The characterization test
// (clinic-scope.test.mjs) is what shows a declaration changing behavior; this one shows the declarations themselves.
const useCases=new Proxy({},{get:()=>()=>undefined});
const registry=[...appointmentRoutes(useCases),...medicalRecordRoutes(useCases),...dashboardRoutes(useCases)];
const name=route=>route.method.toUpperCase()+' '+route.path;

// The scope map of the K2 design (section 1), in the order Express matches the routes.
const WRITE={writePermission:'medical-record.write'};
const EXPECTED=[
  ['GET /appointments',{resource:'none',deferred:true}],
  ['GET /appointments/calendar',{resource:'none'}],
  ['GET /appointments/availability',{resource:'none'}],
  ['POST /appointments',{resource:'none'}],
  ['PATCH /appointments/:id/status',{resource:'appointment'}],
  ['PATCH /appointments/:id/reschedule',{resource:'appointment'}],
  ['PATCH /appointments/:id/cancel',{resource:'appointment'}],
  ['GET /appointments/:id/status-history',{resource:'appointment'}],
  ['POST /appointments/:id/undo-status',{resource:'appointment'}],
  ['POST /appointments/:id/reminder',{resource:'appointment'}],
  ['GET /medical-records',{resource:'none',deferred:true,...WRITE}],
  ['POST /medical-records',{resource:'none',trimBodyPetId:true,...WRITE}],
  ['PATCH /medical-records/:id',{resource:'medicalRecord',...WRITE}],
  ['DELETE /medical-records/:id',{resource:'medicalRecord',...WRITE}],
  ['GET /medical-records/:id/history',{resource:'medicalRecordHistory',...WRITE}],
  ['GET /medical-records/images',{resource:'none',deferred:true,...WRITE}],
  ['POST /medical-records/images',{resource:'none',...WRITE}],
  ['DELETE /medical-records/images/:id',{resource:'medicalImage',...WRITE}],
  ['POST /medical-records/images/:id/restore',{resource:'medicalImage',...WRITE}],
  ['GET /dashboard/clinic',{resource:'none'}],
  ['GET /dashboard/clinic/activity',{resource:'none',permission:'clinic-activity.read',ignoreQueryPetId:true}],
];
const declared=route=>Object.fromEntries(['resource','permission','writePermission','deferred','ignoreQueryPetId','trimBodyPetId'].filter(key=>route[key]!==undefined).map(key=>[key,route[key]]));

test('the registry declares the 21 routes, in the order Express matches them, with the scope of the design',()=>{
  assert.deepEqual(registry.map(name),EXPECTED.map(([route])=>route));
  for(const [index,[route,scope]] of EXPECTED.entries())assert.deepEqual(declared(registry[index]),scope,route);
  assert.equal(registry.filter(route=>route.writePermission).length,9,'the nine medical routes ask medical-record.write, the three GETs included');
  assert.equal(registry.filter(route=>typeof route.handler==='function').length,21);
});
test('the registry passes assertRoutes',()=>{
  assert.doesNotThrow(()=>assertRoutes(registry));
  assert.doesNotThrow(()=>assertRoutes([]));
});

const ok={method:'get',path:'/x',resource:'none',handler:()=>undefined};
const without=key=>Object.fromEntries(Object.entries(ok).filter(([k])=>k!==key));
const BAD={
  'resource missing':without('resource'),
  'resource undefined':{...ok,resource:undefined},
  'resource null':{...ok,resource:null},
  'resource unknown':{...ok,resource:'pet'},
  'resource in another case':{...ok,resource:'None'},
  'resource an empty string':{...ok,resource:''},
  'path names :id and resource is none':{...ok,path:'/x/:id'},
  'path names :id in the middle and resource is none':{...ok,method:'patch',path:'/x/:id/status'},
  'resource appointment and the path names no :id':{...ok,resource:'appointment'},
  'resource medicalRecordHistory and the path names no :id':{...ok,path:'/x/history',resource:'medicalRecordHistory'},
  'resource medicalImage and the path names only another parameter':{...ok,path:'/images/:imageId',resource:'medicalImage'},
  'deferred on a POST':{...ok,method:'post',deferred:true},
  'deferred on a PATCH':{...ok,method:'patch',deferred:true},
  'deferred on a DELETE':{...ok,method:'delete',deferred:true},
  'deferred with an appointment resource':{...ok,resource:'appointment',deferred:true},
  'deferred with a medical record history resource':{...ok,resource:'medicalRecordHistory',deferred:true},
  'handler missing':without('handler'),
  'handler a string':{...ok,handler:'handler'},
  'handler an object':{...ok,handler:{}},
  'handler null':{...ok,handler:null},
  'method missing':without('method'),
  'method unknown':{...ok,method:'put'},
  'method in upper case':{...ok,method:'GET'},
  'path missing':without('path'),
  'path a number':{...ok,path:1},
  'route null':null,
  'route undefined':undefined,
};
test('assertRoutes refuses each bad route with a constant message and the detail in cause',()=>{
  for(const [label,route] of Object.entries(BAD))
    assert.throws(()=>assertRoutes([route]),error=>{
      assert.equal(error.message,'CLINIC_ROUTE_SCOPE_REQUIRED',label);
      assert.match(error.message,/^[A-Z][A-Z0-9_]{2,80}$/,'index.ts prints only a message of this shape: '+label);
      assert.equal(typeof error.cause?.reason,'string',label+': the reason travels in cause');
      assert.equal(typeof error.cause?.route,'string',label+': the route travels in cause');
      return true;
    },label);
});
test('assertRoutes ties resource to :id both ways: a path that names :id has a resource, a path that does not has none',()=>{
  const reason=route=>{try{assertRoutes([route]);}catch(error){return error.cause?.reason;}};
  assert.match(reason({...ok,path:'/x/:id'}),/:id.*resource must say/);
  assert.match(reason({...ok,path:'/x/:id/status',resource:'none'}),/:id.*resource must say/);
  assert.match(reason({...ok,resource:'medicalImage'}),/resource is not none.*:id/);
  assert.doesNotThrow(()=>assertRoutes([{...ok,path:'/x/:id',resource:'appointment'},{...ok,path:'/y/:id/history',resource:'medicalRecordHistory'},{...ok,path:'/z/images/:id',resource:'medicalImage'}]));
  assert.doesNotThrow(()=>assertRoutes([{...ok,path:'/x/:id/y',method:'post',resource:'medicalRecord'}]),'a POST with an id');
  assert.doesNotThrow(()=>assertRoutes([{...ok,path:'/x/:ownerId'}]),'another parameter is not the resource id');
  for(const route of registry)assert.equal(/\/:id(\/|$)/.test(route.path),route.resource!=='none',name(route)+': :id in the path exactly when the route has a resource');
  assert.equal(registry.filter(route=>route.resource!=='none').length,11,'eleven of the 21 routes name a resource');
});
test('assertRoutes refuses a method and path declared twice, and names them in cause only',()=>{
  assert.throws(()=>assertRoutes([ok,{...ok}]),error=>error.message==='CLINIC_ROUTE_SCOPE_REQUIRED'&&error.cause.route==='get /x'&&/twice/.test(error.cause.reason));
  assert.throws(()=>assertRoutes([ok,{...ok,path:'/y'},{...ok}]),/CLINIC_ROUTE_SCOPE_REQUIRED/);
  assert.doesNotThrow(()=>assertRoutes([ok,{...ok,method:'post'},{...ok,path:'/y'}]),'the same path with another method is another route');
});
test('assertRoutes refuses a registry as a whole when only its last route is bad',()=>{
  assert.throws(()=>assertRoutes([...registry,without('resource')]),/CLINIC_ROUTE_SCOPE_REQUIRED/);
  assert.throws(()=>assertRoutes([...registry,{...registry[0]}]),/CLINIC_ROUTE_SCOPE_REQUIRED/,'a second GET /appointments');
});

// What a route is mounted with is its path, then its PEP, then its handler: the router records every handler it is given
// (one that kept only the last could not see a PEP that was never mounted), and the first one is run as a PEP would be.
function recordingRouter(){
  const calls=[];
  return {calls,...Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,...handlers)=>calls.push({method,path,handlers})]))};
}
const deps={source:undefined,lookup:{}};
test('mountRoutes mounts every route once, in registry order, with exactly two handlers: a PEP of its own, then its handler',()=>{
  const router=recordingRouter();
  mountRoutes(router,registry,deps);
  assert.deepEqual(router.calls.map(({method,path})=>method.toUpperCase()+' '+path),registry.map(name));
  for(const [index,{handlers}] of router.calls.entries()){
    const route=registry[index];
    assert.equal(handlers.length,2,name(route)+': the PEP and the handler, nothing else and nothing missing');
    assert.equal(handlers[1],route.handler,name(route)+': the handler is last');
    assert.equal(typeof handlers[0],'function',name(route));
    assert.notEqual(handlers[0],route.handler,name(route)+': what precedes the handler is not the handler');
  }
  assert.equal(new Set(router.calls.map(({handlers})=>handlers[0])).size,registry.length,'every route has a PEP of its own');
});

// A world to run the first handler of a route in: a Core directory that records what it is asked (its breaker is chosen by
// the test), a scope lookup that records what it is asked and finds `pet` (or nothing), and a request that never needs HTTP.
const LOOKUP_OF={appointment:'petOfAppointment',medicalRecord:'petOfMedicalRecord',medicalRecordHistory:'petOfMedicalRecord',medicalImage:'petOfMedicalImage'};
function mounted(route,{breaker,pet='pet-9'}={}){
  const asked=[],looked=[],router=recordingRouter();
  const lookup=Object.fromEntries(['petOfAppointment','petOfMedicalRecord','petOfMedicalImage','petOfDeletedRecord'].map(method=>[method,async id=>{looked.push(method+' '+id);return method==='petOfDeletedRecord'?null:pet;}]));
  const source={breaker,async request(actor,_token,ids){asked.push(ids);return {actor:{sub:actor.sub,role:actor.role,fullName:'Fixture'},pets:[],owners:[]};}};
  mountRoutes(router,[route],{source,lookup});
  const [pep,handler]=router.calls[0].handlers;
  return {asked,looked,handler,async run({role='admin',method=route.method.toUpperCase()}={}){
    let nexted=0;
    const res={locals:{actor:{sub:role+'-1',role}},send(){}},req={method,path:route.path,body:{},query:{},params:{id:'id-1'},headers:{authorization:'Bearer token'}};
    try{await pep(req,res,()=>{nexted++;});}catch(error){return {error,nexted,res};}
    return {nexted,res};
  }};
}
test('the first handler of every route is its PEP: it asks Core once, hands the handler a directory and does not run the handler',async()=>{
  for(const route of registry){
    const world=mounted(route),{error,nexted,res}=await world.run();
    assert.equal(error,undefined,name(route));
    assert.equal(nexted,1,name(route)+': the PEP passes the request on');
    assert.equal(world.asked.length,1,name(route)+': Core is asked once, before the handler');
    assert.deepEqual(world.asked[0].petIds,route.resource==='none'?[]:['pet-9'],name(route)+': the pet of the resource the URL names goes to Core');
    assert.ok(res.locals.directory instanceof RequestDirectory,name(route)+': the handler gets the directory the PEP built');
  }
});
test('the PEP of a route that asks a permission refuses a role without it before anything else: the nine medical routes (HEAD of their GETs too) and the activity read',async()=>{
  const asking=registry.filter(route=>route.writePermission||route.permission);
  assert.equal(asking.length,10);
  for(const route of asking){
    const world=mounted(route),{error,nexted}=await world.run({role:'owner',method:route.method==='get'&&route.writePermission?'HEAD':route.method.toUpperCase()});
    assert.equal(error?.status,403,name(route)+': an owner stops at the PEP');
    assert.equal(nexted,0,name(route));
    assert.deepEqual([world.asked,world.looked],[[],[]],name(route)+': neither Core nor the database was asked');
  }
  for(const route of registry.filter(route=>route.writePermission&&route.method==='get')){
    const {error,nexted}=await mounted(route).run({role:'owner'});
    assert.deepEqual([error,nexted],[undefined,1],name(route)+': the write permission is for the methods that are not GET');
  }
});
test('the PEP of a route that names a resource answers 404 for an id that does not exist, before Core is asked',async()=>{
  for(const route of registry.filter(route=>route.resource!=='none')){
    const world=mounted(route,{pet:null}),{error,nexted}=await world.run();
    assert.equal(error?.status,404,name(route));
    assert.equal(error.message,'Clinic resource not found.',name(route));
    assert.equal(nexted,0,name(route));
    assert.equal(world.asked.length,0,name(route)+': Core is not asked about a resource that is not there');
    assert.equal(world.looked[0],LOOKUP_OF[route.resource]+' id-1',name(route)+': looked up as what the route declares');
    assert.equal(world.looked.includes('petOfDeletedRecord id-1'),route.resource==='medicalRecordHistory','only the history of a record falls back to its last snapshot (AQ-15): '+name(route));
  }
});
test('the PEP of a deferred route defers Core only for a GET with a closed breaker; every other route and every other state asks Core first',async()=>{
  for(const route of registry){
    const world=mounted(route,{breaker:{state:'closed'}}),{nexted,res}=await world.run();
    assert.equal(nexted,1,name(route));
    assert.equal(res.locals.directory instanceof DeferredDirectory,Boolean(route.deferred),name(route)+(route.deferred?': deferred':': eager'));
    assert.equal(world.asked.length,route.deferred?0:1,name(route));
  }
  for(const route of registry.filter(route=>route.deferred)){
    for(const state of ['open','half-open']){
      const world=mounted(route,{breaker:{state}}),{res}=await world.run();
      assert.ok(res.locals.directory instanceof RequestDirectory&&world.asked.length===1,name(route)+': '+state+' asks Core first');
    }
    const world=mounted(route,{breaker:{state:'closed'}}),{res}=await world.run({method:'HEAD'});
    assert.ok(res.locals.directory instanceof RequestDirectory&&world.asked.length===1,name(route)+': HEAD asks Core first');
  }
});
test('mountRoutes mounts nothing when a route is bad',()=>{
  const router=recordingRouter();
  assert.throws(()=>mountRoutes(router,[ok,without('resource')],deps),/CLINIC_ROUTE_SCOPE_REQUIRED/);
  assert.deepEqual(router.calls,[],'the good route before the bad one was not mounted either');
});

test('every route of the registry has a metric label (an unlabelled route would be counted as unknown)',()=>{
  for(const route of registry){
    const concrete='/api'+route.path.replace(/:[A-Za-z]+/g,'id-1'),label=clinicRouteLabel(concrete);
    assert.notEqual(label,undefined,name(route)+' ('+concrete+') has no label in http/routeLabel.ts');
    assert.equal(label,'/api'+route.path,'the label of '+name(route)+' is its path with :id for the resource id');
  }
});
test('a path no route serves has no label, so an id never becomes a label of its own',()=>{
  for(const path of ['/api','/api/nope','/api/dashboard/clinic/nope','/api/dashboard/clinic/activity/nope','/api/appointments/id-1/nope','/api/medical-records/images/id-1/nope','/api/medical-records/images/id-1/restore/nope','/health/ready'])
    assert.equal(clinicRouteLabel(path),undefined,path);
});
