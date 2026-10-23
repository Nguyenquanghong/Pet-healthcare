import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';

// AQ-05: generated from the permission matrix. Every permission has probes; every
// probe runs for all four roles. A role the matrix denies gets 403 with the
// matrix message before any data access; a role it allows passes the guard and
// reaches the (unavailable) data layer. HTTP probes run the real Core (Phase 1
// app, the same services and middleware Core mounts in Phase 2) and the real
// Clinic app; operations that load data before the role check run at service level.
process.env.JWT_SECRET ??= 'permission-matrix-fixture-secret-0123456789abcdef';
const {allows,deniedMessage,permissions,roles}=await import('../../packages/contracts/dist/index.js');
const {PrismaClient}=await import('@prisma/client');
const {createApp:createCore}=await import('../../backend/dist/src/app.js');
const {signToken,verifyToken}=await import('../../backend/dist/src/lib/token.js');
const {createApp:createClinic}=await import('../../services/clinic/dist/app.js');
const {BookingLifecycleService:CoreLifecycle}=await import('../../backend/dist/src/application/services/bookingLifecycle.js');
const {BookingLifecycleService:ClinicLifecycle}=await import('../../services/clinic/dist/application/services/bookingLifecycle.js');
const {AppointmentInvoiceBilling}=await import('../../backend/dist/src/phase2/appointmentBilling.js');
const {ManualSend}=await import('../../services/notification/dist/manualSend.js');
const {MedicalRecordsService}=await import('../../services/clinic/dist/application/services/medicalRecords.js');

class Reached extends Error{constructor(){super('REACHED_DATA_LAYER');}}
// Any property chain is allowed; calling or constructing anything is a data access.
const tripwire=()=>{const trip=new Proxy(function(){},{get:(_t,key)=>key==='then'?undefined:trip,apply:()=>{throw new Reached();},construct:()=>{throw new Reached();}});return trip;};
const withFakes=fakes=>new Proxy(fakes,{get:(target,key)=>key in target?target[key]:key==='then'?undefined:tripwire()});

const id='00000000-0000-4000-8000-000000000001';
const core=[ // [permission, method, path, body?]
  ['booking.manage','PATCH',`/api/appointments/${id}/status`,{status:'confirmed',expectedRevision:0}],
  ['booking.manage','POST',`/api/appointments/${id}/undo-status`,{reason:'fixture',expectedRevision:0}],
  ['booking.manage','POST',`/api/appointments/${id}/reminder`],
  ['booking.manage','GET',`/api/appointments/${id}/status-history`],
  ['booking.manage','PATCH',`/api/hotel-bookings/${id}/status`,{status:'confirmed',expectedRevision:0}],
  ['booking.manage','GET',`/api/hotel-bookings/${id}/status-history`],
  ['hotel.care-note.write','POST',`/api/hotel-bookings/${id}/care-notes`,{note:'fixture'}],
  ['booking.manage','GET','/api/hotel-capacity'],
  ['hotel.capacity.manage','PUT','/api/hotel-capacity/standard',{capacity:10}],
  ['medical-record.write','POST','/api/medical-records',{petId:id}],
  ['medical-record.write','PATCH',`/api/medical-records/${id}`,{title:'fixture'}],
  ['medical-record.write','DELETE',`/api/medical-records/${id}`],
  ['medical-record.write','POST','/api/medical-records/images',{petId:id}],
  ['medical-record.write','DELETE',`/api/medical-records/images/${id}`],
  ['billing.manage','POST','/api/invoices',{type:'appointment',relatedId:id}],
  ['billing.manage','PATCH',`/api/invoices/${id}/pay`,{paymentMethod:'cash'}],
  ['billing.manage','POST',`/api/invoices/${id}/transfer-reject`,{reason:'fixture'}],
  ['billing.audit','GET',`/api/invoices/${id}/payment-history`],
  ['billing.audit','GET','/api/invoices/summary'],
  ['billing.self-service','POST','/api/invoices/checkout',{type:'appointment',relatedId:id}],
  ['billing.self-service','PATCH',`/api/invoices/${id}/onsite`],
  ['billing.self-service','PATCH',`/api/invoices/${id}/bank-transfer`],
  ['billing.self-service','POST',`/api/invoices/${id}/transfer-report`,{}],
  ['billing.self-service','POST',`/api/payments/${id}/vnpay`],
  ['owner.manage','POST','/api/owners',{fullName:'Fixture',phone:'0900000000'}],
  ['owner.manage','POST',`/api/owners/${id}/activation`,{email:'fixture@example.com',customerVerified:true}],
  ['directory.read','GET','/api/owners'],
  ['directory.read','GET','/api/doctors'],
  ['notification.send','POST','/api/notifications/send',{recipientOwnerId:id,title:'t',message:'m'}],
];
const clinic=[
  ['booking.manage','PATCH',`/api/appointments/${id}/status`,{status:'confirmed',expectedRevision:0}],
  ['booking.manage','POST',`/api/appointments/${id}/undo-status`,{reason:'fixture',expectedRevision:0}],
  ['booking.manage','POST',`/api/appointments/${id}/reminder`],
  ['booking.manage','GET',`/api/appointments/${id}/status-history`],
  ['medical-record.write','POST','/api/medical-records',{petId:'pet-1'}],
  ['medical-record.write','PATCH',`/api/medical-records/${id}`,{title:'fixture'}],
  ['medical-record.write','DELETE',`/api/medical-records/${id}`],
  ['medical-record.write','POST','/api/medical-records/images',{petId:'pet-1'}],
  ['medical-record.write','DELETE',`/api/medical-records/images/${id}`],
  ['medical-record.history','GET',`/api/medical-records/${id}/history`],
  // The Clinic router's medical-record.write guard runs first for every non-GET medical route.
  ['medical-record.restore','POST',`/api/medical-records/images/${id}/restore`,undefined,['medical-record.write']],
  ['clinic-activity.read','GET','/api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20'],
];
// Operations whose role check needs loaded data first: [permission, name, run(actor), alsoRequires]
const finished={status:'completed',statusRevision:3,ownerId:'owner-1'};
const lifecycleStore=()=>withFakes({run:async(_kind,_id,work)=>work(withFakes({booking:finished}))});
const service=[
  ['booking.reopen','Core reopen a completed service',actor=>new CoreLifecycle(lifecycleStore()).undo(actor,'appointment',id,{expectedRevision:3,reason:'fixture'}),['booking.manage']],
  ['booking.reopen','Clinic reopen a completed service',actor=>new ClinicLifecycle(lifecycleStore()).undo(actor,'appointment',id,{expectedRevision:3,reason:'fixture'}),['booking.manage']],
  ['billing.manage','Core appointment invoice (Phase 2 billing operation)',actor=>new AppointmentInvoiceBilling(withFakes({user:{findUnique:async()=>({role:actor.role})}}),tripwire()).begin(actor,{appointmentId:id},'key-1',false)],
  ['billing.self-service','Core appointment self checkout (Phase 2 billing operation)',actor=>new AppointmentInvoiceBilling(withFakes({user:{findUnique:async()=>({role:actor.role})}}),tripwire()).begin(actor,{appointmentId:id},'key-1',true)],
  // P11: the pet is loaded before the author is decided; naming another doctor is the admin's call.
  ['medical-record.assign-doctor','Clinic record signed for another doctor',actor=>new MedicalRecordsService(withFakes({records:withFakes({findPet:async()=>({id:'pet-1',ownerId:'owner-1',name:'Pet'})})})).create(actor,{petId:'pet-1',title:'t',visitDate:'2030-01-01',diagnosis:'d',treatment:'t',doctorId:'doctor-2'}),['medical-record.write']],
  ['notification.send','Notification manual send',actor=>new ManualSend(tripwire(),tripwire()).send(actor,'token',{recipientOwnerId:'owner-1',title:'t',message:'m'},'key-1')],
];

const expectation=(role,permission,also=[])=>{const failing=[...also,permission].find(p=>!allows(role,p));return failing?{denied:true,message:deniedMessage(failing)}:{denied:false};};
const verdict=(probe,role,status,message,also)=>{
  const want=expectation(role,probe,also);
  if(want.denied){assert.equal(status,403,`${role} must be denied`);assert.equal(message,want.message,`${role} gets the matrix message`);}
  else assert.ok(!(status===403&&permissions.some(p=>deniedMessage(p)===message)),`${role} must pass the guard (got ${status} ${message})`);
};

test('every permission in the matrix has probes, and the session contract lists exactly the matrix',async()=>{
  const covered=new Set([...core,...clinic,...service].map(p=>p[0]));
  assert.deepEqual(permissions.filter(p=>!covered.has(p)),[]);
  const {readFile}=await import('node:fs/promises');
  const spec=JSON.parse(await readFile(new URL('../../backend/openapi.json',import.meta.url),'utf8'));
  assert.deepEqual(spec.components.schemas.User.properties.permissions.items.enum,permissions);
  const {sessionUser}=await import('../../backend/dist/src/lib/serialize.js');
  for(const role of roles)assert.deepEqual(sessionUser({id:'u',fullName:'U',role}).permissions,permissions.filter(p=>allows(role,p)));
});

async function serve(app){const server=app.listen(0,'127.0.0.1');await once(server,'listening');return {server,base:`http://127.0.0.1:${server.address().port}`};}
async function call(base,role,[,method,path,body]){
  const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+signToken(role+'-1',role),'Content-Type':'application/json','Idempotency-Key':'permission-matrix-1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const text=await res.text();let error;try{error=JSON.parse(text).error;}catch{}
  return {status:res.status,message:error};
}

test('Core HTTP: every role-restricted route answers by the matrix',{timeout:120000},async()=>{
  const client=new PrismaClient({datasources:{db:{url:'postgresql://test:test@127.0.0.1:0/permission_matrix'}}});
  const {server,base}=await serve(createCore(client));
  try{
    for(const probe of core)for(const role of roles){const {status,message}=await call(base,role,probe);verdict(probe[0],role,status,message);}
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await client.$disconnect();}
});

test('Clinic HTTP: every role-restricted route answers by the matrix',{timeout:60000},async()=>{
  const row={id,petId:'pet-1',ownerId:'owner-1'};
  const db=withFakes({appointment:{findUnique:async()=>row},medicalRecord:{findUnique:async()=>row},medicalImage:{findUnique:async()=>row},medicalRecordRevision:{findFirst:async()=>null},$transaction:async work=>work(tripwire())});
  const source={acceptsService:()=>false,request:async actor=>({actor:{...actor,fullName:'Fixture'},pets:[{id:'pet-1',ownerId:'owner-1',name:'Pet',directoryVersion:1}],owners:[{id:'owner-1',fullName:'Owner',directoryVersion:1}]})};
  const {server,base}=await serve(createClinic(db,verifyToken,source));
  try{
    for(const probe of clinic)for(const role of roles){const {status,message}=await call(base,role,probe);verdict(probe[0],role,status,message,probe[4]);}
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('service level: role checks after loading data answer by the matrix, denied roles change nothing',async()=>{
  for(const [permission,name,run,also] of service)for(const role of roles){
    let status,message;
    try{await run({sub:role+'-1',role});status=200;}catch(error){status=error instanceof Reached?'reached':error.status;message=error.message;}
    const want=expectation(role,permission,also);
    if(want.denied){assert.equal(status,403,`${name}: ${role}`);assert.equal(message,want.message,`${name}: ${role}`);}
    else assert.notEqual(status,403,`${name}: ${role} must pass (${message})`);
  }
});
