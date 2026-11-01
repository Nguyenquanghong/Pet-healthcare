import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';

// AQ-05: the probes of permission-matrix.test.mjs that reach Clinic or Notification in a deployment: appointments and medical
// records go to Clinic, /notifications/send to the Notification service. Their real paths are probed in the main matrix, these
// run on the legacy entrypoint (createApp). Same rule as the main matrix: every probe runs for all four roles;
// a role the matrix denies gets 403 with the matrix message before any data access, a role it allows passes the guard and
// reaches the (unavailable) data layer.
process.env.JWT_SECRET ??= 'permission-matrix-fixture-secret-0123456789abcdef';
const {allows,deniedMessage,permissions,roles}=await import('../../packages/contracts/dist/index.js');
const {PrismaClient}=await import('@prisma/client');
const {createApp:createCore}=await import('../../backend/dist/src/app.js');
const {signToken}=await import('../../backend/dist/src/lib/token.js');

const id='00000000-0000-4000-8000-000000000001';
const core=[ // [permission, method, path, body?]
  ['booking.manage','PATCH',`/api/appointments/${id}/status`,{status:'confirmed',expectedRevision:0}],
  ['booking.manage','POST',`/api/appointments/${id}/undo-status`,{reason:'fixture',expectedRevision:0}],
  ['booking.manage','POST',`/api/appointments/${id}/reminder`],
  ['booking.manage','GET',`/api/appointments/${id}/status-history`],
  ['medical-record.write','POST','/api/medical-records',{petId:id}],
  ['medical-record.write','PATCH',`/api/medical-records/${id}`,{title:'fixture'}],
  ['medical-record.write','DELETE',`/api/medical-records/${id}`],
  ['medical-record.write','POST','/api/medical-records/images',{petId:id}],
  ['medical-record.write','DELETE',`/api/medical-records/images/${id}`],
  ['notification.send','POST','/api/notifications/send',{recipientOwnerId:id,title:'t',message:'m'}],
];

const expectation=(role,permission,also=[])=>{const failing=[...also,permission].find(p=>!allows(role,p));return failing?{denied:true,message:deniedMessage(failing)}:{denied:false};};
const verdict=(probe,role,status,message,also)=>{
  const want=expectation(role,probe,also);
  if(want.denied){assert.equal(status,403,`${role} must be denied`);assert.equal(message,want.message,`${role} gets the matrix message`);}
  else assert.ok(!(status===403&&permissions.some(p=>deniedMessage(p)===message)),`${role} must pass the guard (got ${status} ${message})`);
};

async function serve(app){const server=app.listen(0,'127.0.0.1');await once(server,'listening');return {server,base:`http://127.0.0.1:${server.address().port}`};}
async function call(base,role,[,method,path,body]){
  const res=await fetch(base+path,{method,headers:{Authorization:'Bearer '+signToken(role+'-1',role),'Content-Type':'application/json','Idempotency-Key':'permission-matrix-1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const text=await res.text();let error;try{error=JSON.parse(text).error;}catch{}
  return {status:res.status,message:error};
}

test('Core HTTP, Phase 1 app: appointment, medical-record and manual-send routes answer by the matrix',{timeout:120000},async()=>{
  const client=new PrismaClient({datasources:{db:{url:'postgresql://test:test@127.0.0.1:0/permission_matrix'}}});
  const {server,base}=await serve(createCore(client));
  try{
    for(const probe of core)for(const role of roles){const {status,message}=await call(base,role,probe);verdict(probe[0],role,status,message);}
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await client.$disconnect();}
});
