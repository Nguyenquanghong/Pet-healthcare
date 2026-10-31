import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {readFileSync} from 'node:fs';
import express from 'express';
import {createApp} from '../../services/clinic/dist/app.js';
import {BusinessError} from '../../services/clinic/dist/domain/error.js';

// K2 characterization test: what Clinic's HTTP layer decides BEFORE a handler runs (auth, body checks, permission, which
// pet and doctor IDs go to Core, which resource lookups touch the database, deferred versus eager authorization) and
// what each route answers, recorded against the real createApp with a fake database and a fake Core directory.
// Needs `npm run phase2:build` (reads services/clinic/dist), no Docker. The golden file is tools/phase2/clinic-scope.golden.json.
//   stable  : never edited. A refactor that changes one of these observations changed behavior.
//   changed : the N1 and N3 exceptions of phase2-plan/architecture-work/k2-design-20261031.md. Each has `old` (recorded on
//             the code before the PEP) and `new` (the expected answer once the PEP replaces the URL regexes), chosen by
//             PEP_ACTIVE. New is derived from the canonical spelling of the same request, or written by hand.
const PEP_ACTIVE=true; // the PEP commit changes exactly this line
const GOLDEN=new URL('./clinic-scope.golden.json',import.meta.url);

// ---- fake Core directory and fake database ------------------------------------------------
const APPT='appt-1',state={mode:'ok',breaker:undefined,dbDown:false},coreCalls=[],tables=[],seen={handler:false};
const verify=token=>{if(token==='bad')throw new Error('bad token');return {sub:token+'-1',role:token};};
const snapshotOf=(actor,ids)=>({
  actor:{sub:actor.sub,role:actor.role,fullName:'Fixture '+actor.role},
  pets:(ids.petIds??[]).map(id=>({id,ownerId:'owner-1',name:'Pet '+id,directoryVersion:1})),
  owners:[{id:'owner-1',fullName:'Owner',directoryVersion:1}],
  ...(ids.doctorId?{doctor:{id:ids.doctorId,fullName:'Doctor'}}:{}),
});
const source={
  acceptsService:token=>token==='service-token',
  get breaker(){return state.breaker;},
  async operationEvidence(operationId){coreCalls.push({operationId});return {state:'COMMITTED',appointmentId:APPT,invoiceId:'inv-1'};},
  async request(actor,_token,ids,lookup=false){
    coreCalls.push({ids:JSON.parse(JSON.stringify(ids)),lookup});
    if(state.mode==='revoked')throw new BusinessError(401,'Your password was changed. Sign in again.');
    if(state.mode==='forbidden')throw new BusinessError(403,'Owner or staff permission required.');
    if(state.mode==='down')throw new BusinessError(503,'Core directory unavailable. Retry the same request key.');
    return snapshotOf(actor,ids);
  },
};
const blobs={async put(){},async remove(){},signedGetUrl:()=>({url:'https://blob.invalid/x',expiresAt:new Date(0)}),async ensureBucket(){},async check(){}};
const epoch=new Date('2030-01-01T00:00:00Z');
// No row is named like a route word, so the old regexes' `images`/`history` lookups find nothing.
const missing=id=>String(id).startsWith('missing')||['calendar','images','availability','history'].includes(String(id));
const rows={
  appointment:id=>({id,petId:'pet-1',ownerId:'owner-1',doctorId:null,type:'general_checkup',serviceName:'Checkup',clinicName:'Clinic',appointmentDate:epoch,appointmentTime:'09:00',status:'pending',statusRevision:0,ownerNote:null,internalNote:null,createdBy:'staff',createdAt:epoch,updatedAt:epoch}),
  medicalRecord:id=>({id,petId:'pet-1',ownerId:'owner-1',appointmentId:null,doctorId:null,doctorName:'Doctor',title:'Title',visitDate:epoch,symptoms:null,diagnosis:'D',treatment:'T',medications:null,vaccineName:null,followUpDate:null,weightKg:null,temperatureC:null,heartRateBpm:null,internalNote:null,revision:1,createdAt:epoch,updatedAt:epoch}),
  medicalImage:id=>({id,petId:'pet-1',ownerId:'owner-1',storageKey:null,sha256:null,sizeBytes:null,deletedAt:id==='img-deleted'?new Date():null,createdAt:epoch}),
};
const GONE={'rec-gone':{before:{petId:'pet-1',revision:2},after:null},'rec-gone-after':{before:null,after:{petId:'pet-1',revision:1}},'rec-gone-nopet':{before:{revision:2},after:null}};
function handlerOf(model,method,args){
  const where=args?.[0]?.where??{},id=where.id;
  if(model==='appointment'&&method==='findUnique')return missing(id)?null:rows.appointment(id);
  if(model==='medicalRecord'&&method==='findUnique')return missing(id)||id in GONE||id==='rec-gone-none'?null:rows.medicalRecord(id);
  if(model==='medicalImage'&&method==='findUnique')return missing(id)?null:rows.medicalImage(id);
  if(model==='medicalRecordRevision'&&method==='findFirst')return GONE[where.recordId]??null;
  if(model==='medicalRecordRevision'&&method==='findMany')return missing(where.recordId)?[]:[{id:'rv-1',recordId:where.recordId,action:'create',before:null,after:rows.medicalRecord(where.recordId),actorId:'admin-1',actorRole:'admin',recordRevision:1,changedAt:epoch}];
  if(/^appointmentTypePolicy$|^appointmentResourceGroup$/.test(model))return {type:'general_checkup',resourceGroup:'general',durationMinutes:30,capacity:2,openTime:'08:00',closeTime:'17:00',stepMinutes:30,fixedSlots:[]};
  if(method==='findMany'||method==='groupBy')return [];
  if(method==='count')return 0;
  if(method==='create'||method==='update'||method==='upsert')return {...(rows[model]?.('new-1')??{id:'new-1'}),...(args?.[0]?.data??{})};
  return null;
}
const db=new Proxy({},{get(_t,key){
  if(key==='then')return undefined;
  if(key==='$transaction')return async work=>{tables.push('$transaction');return Array.isArray(work)?Promise.all(work):work(db);};
  if(typeof key==='string'&&key.startsWith('$'))return async(strings,...values)=>{
    tables.push(key);
    if(key==='$queryRaw'&&Array.isArray(strings)&&strings.join('?').includes('FROM medical_images'))return missing(values[0])?[]:[rows.medicalImage(values[0])];
    return key==='$executeRaw'||key==='$executeRawUnsafe'?1:[];
  };
  return new Proxy({},{get(_m,method){
    if(method==='then')return undefined;
    return async(...args)=>{
      tables.push(key+'.'+String(method));
      if(state.dbDown&&method==='count')throw new Error('database down');
      return handlerOf(key,String(method),args);
    };
  }});
}});

// Which route handlers ran: the last function given to a Router or app route method is the handler, whatever sits before it.
const flagged=fn=>function flaggedHandler(...args){seen.handler=true;return fn.apply(this,args);};
for(const method of ['get','post','put','patch','delete']){
  const original=express.Router.prototype[method];
  express.Router.prototype[method]=function(path,...fns){const last=fns.pop();return original.call(this,path,...fns,flagged(last));};
}
const originalAppGet=express.application.get;
express.application.get=function(path,...fns){
  if(!fns.length)return originalAppGet.call(this,path);
  const last=fns.pop();return originalAppGet.call(this,path,...fns,flagged(last));
};
const quietStderr=process.stderr.write.bind(process.stderr);
process.stderr.write=(chunk,...rest)=>String(chunk).includes('UNEXPECTED_APPLICATION_ERROR')?true:quietStderr(chunk,...rest);

// ---- requests ----------------------------------------------------------------------------
const servers=[];
async function serve(app){const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
const base=await serve(createApp(db,verify,source,undefined,blobs));
const bare=await serve(createApp(db,verify,undefined,undefined,blobs)); // no Core directory configured
const noVerify=await serve(createApp(db,undefined,source,undefined,blobs)); // no token verifier configured
test.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}});

function send(origin,{method='GET',path,role='admin',token,headers={},body,raw}){
  const payload=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined,tok=token!==undefined?token:role;
  const h={...(tok===null?{}:{Authorization:'Bearer '+tok}),...(payload!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers};
  return new Promise((resolve,reject)=>{
    const req=httpRequest(origin+path,{method,headers:h,agent:false,timeout:10000},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(text);}catch{}
        resolve({status:res.statusCode,headers:res.headers,json,text});
      });
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));
    if(payload!==undefined)req.write(payload);req.end();
  });
}
const breakers={closed:{state:'closed'},open:{state:'open'},'half-open':{state:'half-open'},none:undefined};
async function observe(step){
  const {origin=base,mode='ok',breaker='closed',dbDown=false,...request}=step;
  state.mode=mode;state.breaker=breakers[breaker];state.dbDown=dbDown;
  coreCalls.length=0;tables.length=0;seen.handler=false;
  const res=await send(origin,request);
  return {
    status:res.status,
    error:typeof res.json?.error==='string'?res.json.error:null,
    code:typeof res.json?.code==='string'?res.json.code:null,
    retryAfter:res.headers['retry-after']??null,
    allow:res.headers.allow??null,
    cacheControl:res.headers['cache-control']??null,
    coreCalls:[...coreCalls],
    tables:[...tables],
    reachedHandler:seen.handler,
  };
}
const run=async steps=>{const out=[];for(const step of steps)out.push(await observe(step));return steps.length===1?out[0]:out;};

// ---- the cases -----------------------------------------------------------------------------
const stable=[],changed=[];
const add=(name,...steps)=>{assert.ok(!stable.some(c=>c.name===name)&&!changed.some(c=>c.name===name),'duplicate case '+name);stable.push({name,steps});};
const ROLES=['admin','owner','staff','doctor'];
const REC='rec-1',IMG='img-1',KEY={'Idempotency-Key':'scope-key-1'};
const appointmentBody={petId:'pet-1',type:'general_checkup',date:'2030-01-01',time:'09:00',serviceName:'Checkup'};
const recordBody={petId:'pet-1',title:'Visit',visitDate:'2030-01-01',diagnosis:'D',treatment:'T'};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const imageBody={petId:'pet-1',title:'Photo',mimeType:'image/png',imageUrl:png};

// 1. Every route, every role, valid input and an existing id (21 routes).
const routes=[
  ['GET','/api/appointments'],
  ['GET','/api/appointments/calendar?month=2030-01'],
  ['GET','/api/appointments/availability?type=general_checkup&date=2030-01-01'],
  ['POST','/api/appointments',{body:appointmentBody,headers:KEY}],
  ['PATCH',`/api/appointments/${APPT}/status`,{body:{status:'confirmed',expectedRevision:0}}],
  ['PATCH',`/api/appointments/${APPT}/reschedule`,{body:{date:'2030-01-02',time:'10:00',expectedRevision:0}}],
  ['PATCH',`/api/appointments/${APPT}/cancel`,{body:{expectedRevision:0}}],
  ['GET',`/api/appointments/${APPT}/status-history`],
  ['POST',`/api/appointments/${APPT}/undo-status`,{body:{reason:'fixture',expectedRevision:0}}],
  ['POST',`/api/appointments/${APPT}/reminder`],
  ['GET','/api/medical-records'],
  ['POST','/api/medical-records',{body:{...recordBody,doctorId:'doctor-1'},headers:KEY}],
  ['PATCH',`/api/medical-records/${REC}`,{body:{title:'Changed',expectedRevision:1}}],
  ['DELETE',`/api/medical-records/${REC}?expectedRevision=1`],
  ['GET',`/api/medical-records/${REC}/history`],
  ['GET','/api/medical-records/images'],
  ['POST','/api/medical-records/images',{body:imageBody}],
  ['DELETE',`/api/medical-records/images/${IMG}`],
  ['POST','/api/medical-records/images/img-deleted/restore'],
  ['GET','/api/dashboard/clinic'],
  ['GET','/api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20'],
];
assert.equal(routes.length,21);
for(const role of ROLES)for(const [method,path,extra={}] of routes)add(`route ${role} ${method} ${path}`,{role,method,path,...extra});

// 2. Error order: permission before body shape before 404; JSON syntax before everything.
const medicalRoutes=routes.filter(([,path])=>path.startsWith('/api/medical-records'));
assert.equal(medicalRoutes.length,9);
for(const [method,path] of medicalRoutes){
  add(`order owner ${method} ${path} body array`,{role:'owner',method,path,body:[]});
  add(`order admin ${method} ${path} body array`,{role:'admin',method,path,body:[]});
  add(`order owner ${method} ${path} body string`,{role:'owner',method,path,body:'text'});
}
add('order owner POST /api/medical-records broken JSON',{role:'owner',method:'POST',path:'/api/medical-records',raw:'{"petId":'});
add('order admin POST /api/appointments broken JSON',{method:'POST',path:'/api/appointments',raw:'{"petId":'});
add('order admin PATCH /api/appointments/missing-1/status body array',{method:'PATCH',path:'/api/appointments/missing-1/status',body:[]});
add('order owner POST /api/medical-records/images/img-1/restore revoked',{role:'owner',method:'POST',path:`/api/medical-records/images/${IMG}/restore`,mode:'revoked'});
add('order staff POST /api/medical-records revoked',{role:'staff',method:'POST',path:'/api/medical-records',body:recordBody,mode:'revoked'});

// 3. petId in the query, with the breaker closed and open.
const queryPaths=['/api/appointments','/api/medical-records','/api/medical-records/images','/api/appointments/calendar','/api/appointments/availability'];
const queries={'trimmed':'?petId=%20pet-1%20','plain':'?petId=pet-1','all':'?petId=all','all padded':'?petId=%20all%20','empty':'?petId=','twice':'?petId=a&petId=b','201 characters':'?petId='+'p'.repeat(201),'200 characters':'?petId='+'p'.repeat(200),'bracket':'?petId[]=a'};
for(const breaker of ['closed','open'])for(const path of queryPaths)for(const [label,query] of Object.entries(queries))add(`query ${breaker} ${path} ${label}`,{path:path+query,breaker});
add('query owner GET /api/appointments pet of nobody',{role:'owner',path:'/api/appointments?petId=other',mode:'forbidden'});

// 4. petId in the body of a write.
for(const [label,petId] of Object.entries({number:123,empty:'',null:null,padded:' p ',long:'p'.repeat(201),object:{a:1},true:true,absent:undefined})){
  const body=petId===undefined?{...appointmentBody,petId:undefined}:{...appointmentBody,petId};
  add(`body petId ${label} POST /api/appointments`,{method:'POST',path:'/api/appointments',body,headers:KEY});
  add(`body petId ${label} POST /api/medical-records`,{method:'POST',path:'/api/medical-records',body:{...recordBody,petId},headers:KEY});
  add(`body petId ${label} POST /api/medical-records/images`,{method:'POST',path:'/api/medical-records/images',body:{...imageBody,petId}});
}
add('body petId PATCH /api/medical-records/rec-1',{method:'PATCH',path:`/api/medical-records/${REC}`,body:{petId:'x',title:'t',expectedRevision:1}});
add('body petId PATCH /api/appointments/appt-1/reschedule',{method:'PATCH',path:`/api/appointments/${APPT}/reschedule`,body:{petId:'x',date:'2030-01-02',time:'10:00',expectedRevision:0}});
add('body petId same as resource pet',{method:'PATCH',path:`/api/medical-records/${REC}`,body:{petId:'pet-1',title:'t',expectedRevision:1}});
add('body petId DELETE with body',{method:'DELETE',path:`/api/medical-records/${REC}?expectedRevision=1`,body:{petId:'x'}});
add('body petId GET with body (ignored: GET reads the query)',{path:'/api/appointments/availability',body:{petId:'x'}});
add('body petId GET /api/appointments with body and query',{path:'/api/appointments?petId=q',body:{petId:'x'}});

// 5. doctorId in the body: sent on every eager branch, never on the deferred branch.
for(const [label,doctorId] of Object.entries({d1:'d1',number:123,empty:'',zero:0,null:null,object:{a:1},long:'d'.repeat(300)}))
  add(`doctorId ${label} POST /api/appointments`,{method:'POST',path:'/api/appointments',body:{...appointmentBody,doctorId},headers:KEY});
add('doctorId PATCH reschedule',{method:'PATCH',path:`/api/appointments/${APPT}/reschedule`,body:{doctorId:'d1',date:'2030-01-02',time:'10:00',expectedRevision:0}});
add('doctorId PATCH medical record',{method:'PATCH',path:`/api/medical-records/${REC}`,body:{doctorId:'d1',title:'t',expectedRevision:1}});
add('doctorId DELETE with body',{method:'DELETE',path:`/api/medical-records/${REC}?expectedRevision=1`,body:{doctorId:'d1'}});
add('doctorId POST medical record',{method:'POST',path:'/api/medical-records',body:{...recordBody,doctorId:'d1'},headers:KEY});
for(const breaker of ['closed','open','half-open','none']){
  add(`doctorId GET /api/appointments with body ${breaker}`,{path:'/api/appointments',body:{doctorId:'d1'},breaker});
  add(`doctorId GET /api/medical-records with body ${breaker}`,{path:'/api/medical-records',body:{doctorId:'d1'},breaker});
  add(`doctorId GET /api/appointments/availability with body ${breaker}`,{path:'/api/appointments/availability',body:{doctorId:'d1'},breaker});
}

// 6. A resource named in the URL that does not exist: 404 before Core, and a bad body wins over it.
for(const role of ['admin','owner']){
  add(`missing ${role} PATCH /api/appointments/missing-1/status`,{role,method:'PATCH',path:'/api/appointments/missing-1/status',body:{status:'confirmed',expectedRevision:0}});
  add(`missing ${role} GET /api/appointments/missing-1/status-history`,{role,path:'/api/appointments/missing-1/status-history'});
  add(`missing ${role} POST /api/appointments/missing-1/reminder`,{role,method:'POST',path:'/api/appointments/missing-1/reminder'});
  add(`missing ${role} PATCH /api/medical-records/missing-1`,{role,method:'PATCH',path:'/api/medical-records/missing-1',body:{title:'t',expectedRevision:1}});
  add(`missing ${role} DELETE /api/medical-records/missing-1`,{role,method:'DELETE',path:'/api/medical-records/missing-1?expectedRevision=1'});
  add(`missing ${role} GET /api/medical-records/missing-1/history`,{role,path:'/api/medical-records/missing-1/history'});
  add(`missing ${role} DELETE /api/medical-records/images/missing-1`,{role,method:'DELETE',path:'/api/medical-records/images/missing-1'});
  add(`missing ${role} POST /api/medical-records/images/missing-1/restore`,{role,method:'POST',path:'/api/medical-records/images/missing-1/restore'});
}
add('missing admin PATCH /api/medical-records/missing-1 body array',{method:'PATCH',path:'/api/medical-records/missing-1',body:[]});
add('missing admin DELETE /api/medical-records/images/missing-1 body array',{method:'DELETE',path:'/api/medical-records/images/missing-1',body:[]});
add('missing admin PATCH /api/appointments/missing-1/cancel petId number',{method:'PATCH',path:'/api/appointments/missing-1/cancel',body:{petId:5}});
add('missing admin PATCH /api/appointments/missing-1/cancel revoked',{method:'PATCH',path:'/api/appointments/missing-1/cancel',mode:'revoked'});
add('id with encoded characters',{method:'PATCH',path:'/api/appointments/appt%2D1/status',body:{status:'confirmed',expectedRevision:0}});
add('id with encoded slash',{method:'PATCH',path:'/api/appointments/appt%2F1/status',body:{status:'confirmed',expectedRevision:0}});
add('id that is not decodable',{method:'PATCH',path:'/api/appointments/%E0%A4%A/status',body:{status:'confirmed',expectedRevision:0}});
add('id that is not decodable (medical record)',{method:'PATCH',path:'/api/medical-records/%E0%A4%A',body:{title:'t'}});
add('id that is not decodable (GET history)',{path:'/api/medical-records/%E0%A4%A/history'});

// 7. History of a deleted record is scoped by its last snapshot (AQ-15).
for(const id of ['rec-1','rec-gone','rec-gone-after','rec-gone-nopet','rec-gone-none'])
  for(const role of ['admin','owner','staff'])add(`history ${role} GET /api/medical-records/${id}/history`,{role,path:`/api/medical-records/${id}/history`});
add('history deleted record PATCH never looks at revisions',{method:'PATCH',path:'/api/medical-records/rec-gone',body:{title:'t',expectedRevision:1}});
add('history deleted record DELETE never looks at revisions',{method:'DELETE',path:'/api/medical-records/rec-gone?expectedRevision=1'});
add('history deleted record owner revoked',{role:'owner',path:'/api/medical-records/rec-gone/history',mode:'revoked'});

// 8. Reserved ids: the words of sibling routes are not resource ids.
add('reserved PATCH /api/appointments/calendar/status',{method:'PATCH',path:'/api/appointments/calendar/status',body:{status:'confirmed',expectedRevision:0}});
add('reserved PATCH /api/appointments/availability/cancel',{method:'PATCH',path:'/api/appointments/availability/cancel',body:{}});
add('reserved DELETE /api/medical-records/images',{method:'DELETE',path:'/api/medical-records/images'});
add('reserved owner DELETE /api/medical-records/images',{role:'owner',method:'DELETE',path:'/api/medical-records/images'});
add('reserved POST /api/medical-records/images/calendar/restore',{method:'POST',path:'/api/medical-records/images/calendar/restore'});
add('reserved POST /api/medical-records/images/images/restore',{method:'POST',path:'/api/medical-records/images/images/restore'});
add('reserved PATCH /api/medical-records/calendar',{method:'PATCH',path:'/api/medical-records/calendar',body:{title:'t'}});
add('reserved GET /api/medical-records/availability/history',{path:'/api/medical-records/availability/history'});

// 9. Deferred reads: GET, exact path, closed breaker only. Everything else asks Core first.
const deferredPaths=['/api/appointments','/api/medical-records','/api/medical-records/images'];
for(const path of deferredPaths){
  for(const breaker of ['closed','open','half-open','none'])for(const role of ['admin','owner'])add(`deferred ${role} GET ${path} breaker ${breaker}`,{role,path,breaker});
  for(const mode of ['revoked','forbidden','down'])add(`deferred admin GET ${path} Core ${mode}`,{path,mode});
  add(`deferred owner GET ${path} Core revoked, open`,{role:'owner',path,mode:'revoked',breaker:'open'});
  add(`deferred admin GET ${path} with filters`,{path:path+'?pageSize=5&status=pending'});
  add(`deferred admin GET ${path} invalid page`,{path:path+'?pageSize=0'});
  add(`deferred ${path}/ trailing slash is eager`,{path:path+'/'});
  add(`deferred ${path}/ trailing slash is eager, open`,{path:path+'/',breaker:'open'});
  add(`deferred ${path.toUpperCase()} upper case is eager`,{path:path.toUpperCase()});
  add(`deferred ${path} with query separator is still deferred`,{path:path+'?'});
  add(`deferred HEAD ${path} is eager`,{method:'HEAD',path});
  add(`deferred POST ${path}`,{method:'POST',path,body:{}});
}
add('deferred state changes between requests on one app',
  {path:'/api/appointments',breaker:'closed'},{path:'/api/appointments',breaker:'open'},{path:'/api/appointments',breaker:'half-open'},
  {path:'/api/appointments',breaker:'none'},{path:'/api/appointments',breaker:'closed'});
add('deferred a failed Core answer, then recovery',
  {path:'/api/medical-records',mode:'down'},{path:'/api/medical-records',mode:'ok'},{path:'/api/medical-records',mode:'revoked'},{path:'/api/medical-records',mode:'ok'});
add('eager calendar and availability ask Core first',{path:'/api/appointments/calendar?month=2030-01'},{path:'/api/appointments/availability?type=general_checkup&date=2030-01-01'});
add('eager GET /api/appointments/appt-1/status-history, Core revoked',{path:`/api/appointments/${APPT}/status-history`,mode:'revoked'});

// 10. HEAD (N2): not a GET, so it takes the write branch of the medical gate and never defers.
for(const role of ROLES){
  for(const path of ['/api/medical-records','/api/medical-records/images',`/api/medical-records/${REC}/history`,'/api/medical-records/rec-gone/history'])
    add(`head ${role} HEAD ${path}`,{role,method:'HEAD',path});
  add(`head ${role} HEAD /api/appointments`,{role,method:'HEAD',path:'/api/appointments'});
  add(`head ${role} HEAD /api/dashboard/clinic`,{role,method:'HEAD',path:'/api/dashboard/clinic'});
}
add('head admin HEAD /api/medical-records?petId=p1 (the query petId is not sent)',{method:'HEAD',path:'/api/medical-records?petId=p1'});
add('head admin HEAD /api/appointments?petId=p1',{method:'HEAD',path:'/api/appointments?petId=p1'});
add('head admin HEAD /api/medical-records breaker closed stays eager',{method:'HEAD',path:'/api/medical-records',breaker:'closed'});
add('head admin HEAD /api/appointments/appt-1/status-history',{method:'HEAD',path:`/api/appointments/${APPT}/status-history`});
add('head admin HEAD /api/medical-records/missing-1/history',{method:'HEAD',path:'/api/medical-records/missing-1/history'});
add('trailing slash: owner POST /api/medical-records/ with an array is gated like the exact path',{role:'owner',method:'POST',path:'/api/medical-records/',body:[]});
add('trailing slash: PATCH /api/appointments/appt-1/cancel/ looks the resource up',{method:'PATCH',path:`/api/appointments/${APPT}/cancel/`,body:{expectedRevision:0}});
add('trailing slash: owner PATCH /api/medical-records/rec-1/ is gated',{role:'owner',method:'PATCH',path:`/api/medical-records/${REC}/`,body:{title:'t'}});
add('trailing slash: GET /api/medical-records/rec-1/history/ looks the record up',{path:`/api/medical-records/${REC}/history/`});
add('trailing slash: DELETE /api/medical-records/images/img-1/ looks the image up',{method:'DELETE',path:`/api/medical-records/images/${IMG}/`});
add('head owner HEAD /api/medical-records/rec-1/history revoked',{role:'owner',method:'HEAD',path:`/api/medical-records/${REC}/history`,mode:'revoked'});

// 11. Activity: the exact path is rejected early for roles without the permission, and its query petId is not gathered.
const activity='/api/dashboard/clinic/activity',window='from=2030-09-21&to=2030-10-20';
for(const role of ROLES){
  add(`activity ${role} GET with window`,{role,path:`${activity}?${window}`});
  add(`activity ${role} GET with petId`,{role,path:`${activity}?${window}&petId=x`});
}
add('activity no token is 401 and no-store',{path:`${activity}?${window}`,token:null});
add('activity bad token is 401 and no-store',{path:`${activity}?${window}`,token:'bad'});
add('activity owner revoked',{role:'owner',path:`${activity}?${window}`,mode:'revoked'});
add('activity admin Core down',{path:`${activity}?${window}`,mode:'down'});
add('activity admin forbidden by Core',{path:`${activity}?${window}`,mode:'forbidden'});
add('activity admin with body',{path:`${activity}?${window}`,body:{petId:'x',doctorId:'d1'}});
add('activity admin invalid window',{path:`${activity}?from=2030-02-30&to=2030-03-01`});
add('activity admin petId as array',{path:`${activity}?${window}&petId=a&petId=b`});
add('activity owner HEAD',{role:'owner',method:'HEAD',path:`${activity}?${window}`});

// 12. Outside the PEP: authentication, billing, health, the 404 and the paths no route owns.
add('auth no token',{path:'/api/appointments',token:null});
add('auth no token POST',{method:'POST',path:'/api/medical-records',token:null,body:recordBody});
add('auth Basic scheme',{path:'/api/appointments',token:null,headers:{Authorization:'Basic abc'}});
add('auth bad token',{path:'/api/appointments',token:'bad'});
add('auth token of 8192 characters',{path:'/api/appointments',token:'a'.repeat(8192-7)});
add('auth token of 8193 characters',{path:'/api/appointments',token:'a'.repeat(8193)});
add('auth no token on an unknown route',{path:'/api/nope',token:null});
add('auth broken JSON on an unknown route',{method:'POST',path:'/api/nope',raw:'{'});
add('auth bad token on an unknown route',{path:'/api/nope',token:'bad'});
add('auth no Core directory is 503',{origin:bare,path:'/api/appointments'});
add('auth no Core directory is 503 for an unknown route',{origin:bare,path:'/api/nope'});
add('auth no Core directory, no token',{origin:bare,path:'/api/appointments',token:null});
add('auth no verifier is 503',{origin:noVerify,path:'/api/appointments'});
add('payload of valid JSON that is not an object',{method:'POST',path:'/api/appointments',raw:'42',headers:KEY});
add('payload with an unsupported content type',{method:'POST',path:'/api/appointments',raw:'petId=1',headers:{'Content-Type':'application/x-www-form-urlencoded',...KEY}});
add('payload with a text content type',{method:'POST',path:'/api/appointments',raw:'hello',headers:{'Content-Type':'text/plain',...KEY}});
add('internal without service token',{method:'POST',path:'/internal/billing-reservations/op-1/commit',token:null});
add('internal with wrong service token',{path:'/internal/billing-sources/a-1',token:null,headers:{'X-Service-Token':'wrong'}});
add('internal unknown path',{path:'/internal/khac',token:null});
add('internal unknown path with service token',{path:'/internal/khac',token:null,headers:{'X-Service-Token':'service-token'}});
add('internal B1 GET billing-sources',{path:'/internal/billing-sources/a-1',headers:{'X-Service-Token':'service-token'}});
add('internal B1 without actor',{path:'/internal/billing-sources/a-1',token:null,headers:{'X-Service-Token':'service-token'}});
add('internal B2 PUT billing-reservations',{method:'PUT',path:'/internal/billing-reservations/op-1',body:{appointmentId:'a-1',expectedRevision:0},headers:{'X-Service-Token':'service-token'}});
add('internal B2 bad body',{method:'PUT',path:'/internal/billing-reservations/op-1',body:{appointmentId:5},headers:{'X-Service-Token':'service-token'}});
add('internal B3 GET billing-reservations',{path:'/internal/billing-reservations/op-1',headers:{'X-Service-Token':'service-token'}});
add('internal B4 POST commit',{method:'POST',path:'/internal/billing-reservations/op-1/commit',headers:{'X-Service-Token':'service-token'}});
add('internal B5 POST release',{method:'POST',path:'/internal/billing-reservations/op-1/release',headers:{'X-Service-Token':'service-token'}});
add('internal B4 commit with a body',{method:'POST',path:'/internal/billing-reservations/op-1/commit',body:{x:1},headers:{'X-Service-Token':'service-token'}});
add('internal billing router with no Core directory',{origin:bare,path:'/internal/billing-sources/a-1',headers:{'X-Service-Token':'service-token'}});
add('health live needs no bearer',{path:'/health/live',token:null});
add('health ready needs no bearer',{path:'/health/ready',token:null});
add('health ready when the database is down',{path:'/health/ready',token:null,dbDown:true});
add('health live without Core directory',{origin:bare,path:'/health/live',token:null});
add('health unknown sibling',{path:'/health/other',token:null});
add('outside any route',{path:'/nope',token:null});
add('outside any route with a token',{path:'/nope'});

// 13. changed: the N1 and N3 exceptions. `like` names the canonical spelling a variant must behave as once the PEP routes
// by the matched route; `expect` is written by hand when no canonical spelling exists.
const notFound={status:404,error:'Clinic route not found.',code:null,retryAfter:null,allow:null,cacheControl:null,coreCalls:[],tables:[],reachedHandler:false};
const move=(name,step,rule)=>{assert.ok(!stable.some(c=>c.name===name)&&!changed.some(c=>c.name===name),'duplicate case '+name);changed.push({name,step,...rule});};
// N1. A route that does not exist answers 404 without reading the database or asking Core.
move('N1 admin GET /api/nope, Core revoked',{path:'/api/nope',mode:'revoked'},{expect:notFound});
move('N1 admin GET /api/nope, Core down',{path:'/api/nope',mode:'down'},{expect:notFound});
move('N1 admin GET /api/nope, Core forbids',{path:'/api/nope',mode:'forbidden'},{expect:notFound});
move('N1 admin GET /api/nope',{path:'/api/nope'},{expect:notFound});
move('N1 admin GET /api',{path:'/api'},{expect:notFound});
move('N1 admin GET /api/',{path:'/api/'},{expect:notFound});
move('N1 admin POST /api/dashboard/clinic/activity (a method no route has)',{method:'POST',path:`${activity}?${window}`,body:{}},{expect:{...notFound,cacheControl:'no-store'}});
move('N1 admin POST /api/nope with an array',{method:'POST',path:'/api/nope',body:[]},{expect:notFound});
move('N1 admin POST /api/nope with petId and doctorId',{method:'POST',path:'/api/nope',body:{petId:'pet-1',doctorId:'d1'}},{expect:notFound});
move('N1 owner POST /api/medical-records/rec-1/nope',{role:'owner',method:'POST',path:`/api/medical-records/${REC}/nope`,body:{}},{expect:notFound});
move('N1 owner POST /api/medical-records/missing-1/nope (unknown id)',{role:'owner',method:'POST',path:'/api/medical-records/missing-1/nope',body:{}},{expect:notFound});
move('N1 admin GET /api/appointments/appt-1/nope',{path:`/api/appointments/${APPT}/nope`},{expect:notFound});
move('N1 admin GET /api/appointments/missing-1/nope (no existence oracle)',{path:'/api/appointments/missing-1/nope'},{expect:notFound});
move('N1 admin GET /api/appointments/appt-1/nope, Core revoked',{path:`/api/appointments/${APPT}/nope`,mode:'revoked'},{expect:notFound});
move('N1 admin DELETE /api/appointments/appt-1 (a method no route has)',{method:'DELETE',path:`/api/appointments/${APPT}`},{expect:notFound});
move('N1 admin PUT /api/medical-records',{method:'PUT',path:'/api/medical-records',body:{}},{expect:notFound});
move('N1 doctor PATCH /api/appointments (a method no route has)',{role:'doctor',method:'PATCH',path:'/api/appointments',body:{}},{expect:notFound});
move('N1 admin GET /api/dashboard/nope',{path:'/api/dashboard/nope'},{expect:notFound});
move('N1 admin GET /api/dashboard/clinic/activity/nope',{path:'/api/dashboard/clinic/activity/nope'},{expect:{...notFound,cacheControl:'no-store'}});
move('N1 admin GET /api/medical-records/images/img-1',{path:`/api/medical-records/images/${IMG}`},{expect:notFound});
// OPTIONS: once routes carry their own PEP the framework answers Allow without asking Core (same answer, no Core call, no table).
const options=(name,step)=>move(name,step,{like:{...step,mode:'ok'},noCore:true});
options('N1 admin OPTIONS /api/appointments',{method:'OPTIONS',path:'/api/appointments'});
options('N1 admin OPTIONS /api/appointments/appt-1/cancel',{method:'OPTIONS',path:`/api/appointments/${APPT}/cancel`});
options('N1 admin OPTIONS /api/medical-records/rec-1',{method:'OPTIONS',path:`/api/medical-records/${REC}`});
// An owner's OPTIONS is refused today by the write gate (OPTIONS is not GET); with per-route PEPs it is answered like an admin's.
move('N1 owner OPTIONS /api/medical-records',{role:'owner',method:'OPTIONS',path:'/api/medical-records'},{like:{role:'admin',method:'OPTIONS',path:'/api/medical-records'},noCore:true});
options('N1 admin OPTIONS /api/appointments, Core revoked',{method:'OPTIONS',path:'/api/appointments',mode:'revoked'});
options('N1 admin OPTIONS /api/appointments, Core down',{method:'OPTIONS',path:'/api/appointments',mode:'down'});
move('N1 admin OPTIONS /api/nope',{method:'OPTIONS',path:'/api/nope'},{expect:notFound});
// N3. A variant of the URL follows the route Express matched (case, trailing slash), not a case-sensitive regex.
const canonical=(name,variant,like)=>move(name,variant,{like});
canonical('N3 admin PATCH /api/APPOINTMENTS/appt-1/cancel',{method:'PATCH',path:`/api/APPOINTMENTS/${APPT}/cancel`,body:{expectedRevision:0}},{method:'PATCH',path:`/api/appointments/${APPT}/cancel`,body:{expectedRevision:0}});
canonical('N3 admin PATCH /api/Appointments/missing-1/status',{method:'PATCH',path:'/api/Appointments/missing-1/status',body:{status:'confirmed',expectedRevision:0}},{method:'PATCH',path:'/api/appointments/missing-1/status',body:{status:'confirmed',expectedRevision:0}});
canonical('N3 owner PATCH /api/APPOINTMENTS/appt-1/status, Core revoked',{role:'owner',method:'PATCH',path:`/api/APPOINTMENTS/${APPT}/status`,body:{status:'confirmed',expectedRevision:0},mode:'revoked'},{role:'owner',method:'PATCH',path:`/api/appointments/${APPT}/status`,body:{status:'confirmed',expectedRevision:0},mode:'revoked'});
canonical('N3 admin GET /api/APPOINTMENTS/appt-1/status-history',{path:`/api/APPOINTMENTS/${APPT}/status-history`},{path:`/api/appointments/${APPT}/status-history`});
canonical('N3 owner POST /api/MEDICAL-RECORDS with a body array',{role:'owner',method:'POST',path:'/api/MEDICAL-RECORDS',body:[]},{role:'owner',method:'POST',path:'/api/medical-records',body:[]});
canonical('N3 owner POST /api/MEDICAL-RECORDS',{role:'owner',method:'POST',path:'/api/MEDICAL-RECORDS',body:recordBody,headers:KEY},{role:'owner',method:'POST',path:'/api/medical-records',body:recordBody,headers:KEY});
canonical('N3 owner PATCH /api/Medical-Records/rec-1',{role:'owner',method:'PATCH',path:`/api/Medical-Records/${REC}`,body:{title:'t',expectedRevision:1}},{role:'owner',method:'PATCH',path:`/api/medical-records/${REC}`,body:{title:'t',expectedRevision:1}});
canonical('N3 owner DELETE /api/MEDICAL-RECORDS/IMAGES/img-1',{role:'owner',method:'DELETE',path:`/api/MEDICAL-RECORDS/IMAGES/${IMG}`},{role:'owner',method:'DELETE',path:`/api/medical-records/images/${IMG}`});
canonical('N3 admin DELETE /api/MEDICAL-RECORDS/rec-1',{method:'DELETE',path:`/api/MEDICAL-RECORDS/${REC}?expectedRevision=1`},{method:'DELETE',path:`/api/medical-records/${REC}?expectedRevision=1`});
canonical('N3 owner GET /api/MEDICAL-RECORDS/rec-1/history',{role:'owner',path:`/api/MEDICAL-RECORDS/${REC}/history`},{role:'owner',path:`/api/medical-records/${REC}/history`});
canonical('N3 admin POST /api/medical-records/ pads petId',{method:'POST',path:'/api/medical-records/',body:{...recordBody,petId:' p '},headers:KEY},{method:'POST',path:'/api/medical-records',body:{...recordBody,petId:' p '},headers:KEY});
canonical('N3 admin GET /api/medical-records/rec-gone/history/ falls back to the last snapshot',{path:'/api/medical-records/rec-gone/history/'},{path:'/api/medical-records/rec-gone/history'});
canonical('N3 owner GET /api/medical-records/rec-gone/history/',{role:'owner',path:'/api/medical-records/rec-gone/history/'},{role:'owner',path:'/api/medical-records/rec-gone/history'});
canonical('N3 owner GET /api/dashboard/clinic/activity/ is rejected early',{role:'owner',path:`${activity}/?${window}&petId=x`},{role:'owner',path:`${activity}?${window}&petId=x`});
canonical('N3 doctor GET /api/dashboard/clinic/activity/',{role:'doctor',path:`${activity}/?${window}`},{role:'doctor',path:`${activity}?${window}`});
canonical('N3 admin GET /api/dashboard/clinic/activity/ drops the query petId',{path:`${activity}/?${window}&petId=x`},{path:`${activity}?${window}&petId=x`});
canonical('N3 admin GET /api/DASHBOARD/CLINIC/ACTIVITY drops the query petId',{path:`/api/DASHBOARD/CLINIC/ACTIVITY?${window}&petId=x`},{path:`${activity}?${window}&petId=x`});
canonical('N3 owner GET /api/Dashboard/Clinic/Activity',{role:'owner',path:`/api/Dashboard/Clinic/Activity?${window}`},{role:'owner',path:`${activity}?${window}`});
// A reserved word as an id: the old regex looked up an image named `history`; the registry matches `/:id/history` with id `images`.
move('N3 admin GET /api/medical-records/images/history',{path:'/api/medical-records/images/history'},{like:{path:'/api/medical-records/calendar/history'}});
move('N3 owner GET /api/medical-records/images/history',{role:'owner',path:'/api/medical-records/images/history'},{like:{role:'owner',path:'/api/medical-records/calendar/history'}});
// The old regex read the raw path; the registry reads what Express matched and decoded. These four were added after the golden
// was recorded, so their `old` comes from the regex of legacyRequestScope (git show 6d42c3f:services/clinic/src/app.ts) run on a
// build of that commit; the same build reproduces every stable case and every other `old` of this file. Two of the four reach a
// handler once the PEP routes them: a reserved id is not looked up, so the handler answers its own 404 (as `calendar/status` does).
const confirm={status:'confirmed',expectedRevision:0};
// `%63` is `c`: the regex saw a resource named `%63alendar` and looked it up; the route sees the reserved id `calendar`.
move('N3 admin PATCH /api/appointments/%63alendar/status (an encoded reserved word)',{method:'PATCH',path:'/api/appointments/%63alendar/status',body:confirm},{like:{method:'PATCH',path:'/api/appointments/calendar/status',body:confirm}});
// The regex took `images/` for a prefix and looked up the id `status`, which this fixture says exists, so `old` shows Core asked about
// pet-1 (a real database has no such row: the middleware would 404 with 'Clinic resource not found.' and no Core call). The route
// `/appointments/:id/status` takes `images` for the id, a reserved word, and looks nothing up.
move('N3 admin PATCH /api/appointments/images/status (the regex took images/ for a prefix)',{method:'PATCH',path:'/api/appointments/images/status',body:confirm},{like:{method:'PATCH',path:'/api/appointments/calendar/status',body:confirm}});
// A URL that does not decode never matches a route with a parameter: Express fails before any PEP, and the error handler does not expose it.
// The regex checked the write permission (403) and the body (422) first, and failed on the decode only when it reached the lookup.
move('N3 owner PATCH /api/medical-records/%E0%A4%A (a URL that does not decode fails before the gate)',{role:'owner',method:'PATCH',path:'/api/medical-records/%E0%A4%A',body:{title:'t',expectedRevision:1}},{like:{method:'PATCH',path:'/api/medical-records/%E0%A4%A',body:{title:'t'}}});
move('N3 admin PATCH /api/medical-records/%E0%A4%A with a body array',{method:'PATCH',path:'/api/medical-records/%E0%A4%A',body:[]},{like:{method:'PATCH',path:'/api/medical-records/%E0%A4%A',body:{title:'t'}}});

// ---- replay ---------------------------------------------------------------------------------
// The golden file was recorded once on the code before the K2 changes (`old`; `new` from `like`/`expect`/`noCore` of the cases
// above). Record mode is gone so that a changed behavior cannot be re-recorded as the new truth.
const golden=JSON.parse(readFileSync(GOLDEN,'utf8'));

test('the golden file lists exactly the cases of this file',()=>{
  assert.deepEqual(Object.keys(golden.stable),stable.map(c=>c.name));
  assert.deepEqual(Object.keys(golden.changed),changed.map(c=>c.name));
  assert.ok(stable.length>=300,'the stable group is large enough to mean something ('+stable.length+')');
  for(const [name,{old,new:expected}] of Object.entries(golden.changed))assert.notDeepEqual(old,expected,name+': a changed case must differ between old and new (otherwise it belongs in stable)');
});
test('stable: what Clinic decides before and around its handlers does not change',async t=>{
  for(const c of stable)await t.test(c.name,async()=>assert.deepEqual(await run(c.steps),golden.stable[c.name]));
});
test('changed: the N1 and N3 exceptions answer '+(PEP_ACTIVE?'as the PEP does (new)':'as before the PEP (old)'),async t=>{
  for(const c of changed)await t.test(c.name,async()=>assert.deepEqual(await run([c.step]),golden.changed[c.name][PEP_ACTIVE?'new':'old']));
});
