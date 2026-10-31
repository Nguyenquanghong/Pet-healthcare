import test from 'node:test';
import assert from 'node:assert/strict';
import {appointmentRoutes} from '../../services/clinic/dist/http/routes/appointments.js';
import {medicalRecordRoutes} from '../../services/clinic/dist/http/routes/medicalRecords.js';
import {dashboardRoutes} from '../../services/clinic/dist/http/routes/dashboard.js';
import {assertRoutes,mountRoutes} from '../../services/clinic/dist/http/scope.js';
import {clinicRouteLabel} from '../../services/clinic/dist/http/routeLabel.js';

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
test('assertRoutes refuses a method and path declared twice, and names them in cause only',()=>{
  assert.throws(()=>assertRoutes([ok,{...ok}]),error=>error.message==='CLINIC_ROUTE_SCOPE_REQUIRED'&&error.cause.route==='get /x'&&/twice/.test(error.cause.reason));
  assert.throws(()=>assertRoutes([ok,{...ok,path:'/y'},{...ok}]),/CLINIC_ROUTE_SCOPE_REQUIRED/);
  assert.doesNotThrow(()=>assertRoutes([ok,{...ok,method:'post'},{...ok,path:'/y'}]),'the same path with another method is another route');
});
test('assertRoutes refuses a registry as a whole when only its last route is bad',()=>{
  assert.throws(()=>assertRoutes([...registry,without('resource')]),/CLINIC_ROUTE_SCOPE_REQUIRED/);
  assert.throws(()=>assertRoutes([...registry,{...registry[0]}]),/CLINIC_ROUTE_SCOPE_REQUIRED/,'a second GET /appointments');
});

// What a route is mounted with is its path, then whatever precedes the handler (its PEP), then the handler.
function recordingRouter(){
  const calls=[];
  return {calls,...Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,...handlers)=>calls.push({method,path,handler:handlers.at(-1)})]))};
}
const deps={source:undefined,lookup:{}};
test('mountRoutes mounts every route once, in registry order, with its handler last',()=>{
  const router=recordingRouter();
  mountRoutes(router,registry,deps);
  assert.deepEqual(router.calls.map(({method,path})=>method.toUpperCase()+' '+path),registry.map(name));
  assert.ok(router.calls.every((call,index)=>call.handler===registry[index].handler));
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
