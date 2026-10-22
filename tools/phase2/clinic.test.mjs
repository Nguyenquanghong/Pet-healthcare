import test from 'node:test';
import {waitForQueueIdle} from './test-project.mjs';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {PrismaClient as CoreClient} from '@prisma/client';
import {PrismaClient as ClinicClient} from '../../services/clinic/src/generated/client/index.js';
import {PrismaClient as NotificationClient} from '../../services/notification/src/generated/client/index.js';
import {createCoreApp} from '../../backend/dist/src/phase2/coreApp.js';
import {signToken} from '../../backend/dist/src/lib/token.js';
import {ClinicInbox} from '../../services/clinic/dist/inbox.js';
import {DirectorySync} from '../../services/clinic/dist/directorySync.js';
import {backfill} from '../../services/clinic/dist/backfill.js';
import {OutboxRelay as CoreRelay} from '../../backend/dist/src/phase2/relay.js';
import {RuntimeOutboxStore} from '../../backend/dist/src/infrastructure/persistence/runtimeOutboxStore.js';
import {OutboxRelay as ClinicRelay} from '../../services/clinic/dist/relay.js';
import {topology,declareTopology,publishConfirmed} from '@nipopeto/messaging';
import amqp from 'amqplib';

assert.equal(process.env.PHASE2_TEST_CONFIRM,'pet-phase2-p1-test','Use guarded phase2:test:clinic');
const urls={core:'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test',clinic:'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof',notification:'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof'};
const core=new CoreClient({datasourceUrl:urls.core}),clinic=new ClinicClient({datasourceUrl:urls.clinic}),notification=new NotificationClient({datasourceUrl:urls.notification});
const run=randomUUID(),credential='p3-directory-fixture-'+randomUUID(),owner=randomUUID(),other=randomUUID(),admin=randomUUID(),doctor=randomUUID(),staff=randomUUID();
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',prefix='p3.clinic.'+run,routes=topology(prefix),tokens={},handles=[],bases=[];
const date=new Date(Date.now()+7*3600000+86400000).toISOString().slice(0,10);
let pet,otherPet,server,coreUrl,corePort,connection,channel,sync,stopped=false,declared=false;
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=18000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(30);}throw new Error('Timeout: '+label);}
const close=s=>s?new Promise(r=>s.close(r)):Promise.resolve();
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await close(s);return p;}
async function startCore(){server=createCoreApp(core,{clinicUrl:bases[0],clinicToken:credential}).listen(corePort,'127.0.0.1');await once(server,'listening');}
async function processHandle(file,env,ready){const child=spawn(process.execPath,[file],{env:{...process.env,JWT_PRIVATE_KEY:'',JWT_SECRET:'',...env},stdio:'pipe'});let output='',exited=false;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('exit',()=>exited=true);const h={stop:async()=>{if(!exited){child.kill();await once(child,'exit');}},logs:()=>output};handles.push(h);await until(async()=>{if(exited)throw new Error('Built process exited: '+output.replace(/postgresql:\/\/\S+/g,'[redacted]'));return ready?ready():output.includes('worker-ready');},'built process ready');return h;}
async function request(path,{base=coreUrl,token=tokens.owner,method='GET',body,key,headers={}}={}){const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});return{status:r.status,body:r.status===204?null:await r.json()};}
const status=(r,n)=>{assert.equal(r.status,n,JSON.stringify(r.body));return r.body;};
const appointment=(time,extras={})=>({petId:pet.id,type:'general_checkup',date,time,serviceName:'P3 '+run,...extras});
const create=async(time,extras={},options={})=>status(await request('/api/appointments',{method:'POST',body:appointment(time,extras),key:randomUUID(),...options}),201).appointment;
async function change(a,to,token=tokens.admin){return status(await request(`/api/appointments/${a.id}/status`,{method:'PATCH',token,body:{status:to,expectedRevision:a.statusRevision}}),200).appointment;}
const record=(a,extras={})=>({petId:pet.id,appointmentId:a?.id,title:'P3 medical '+run,doctorName:'Synthetic doctor',visitDate:date,diagnosis:'Synthetic diagnosis',treatment:'Synthetic treatment',internalNote:'P3_PRIVATE_MARKER',weightKg:4.25,...extras});
async function connect(){let c;await until(async()=>{try{c=await amqp.connect(broker,{timeout:1000});return true;}catch{return false;}},'broker');c.on('error',()=>{});return c;}
const docker=(...args)=>execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml',...args],{stdio:'pipe',timeout:30000});
async function relayCore(id){const relay=new CoreRelay(new RuntimeOutboxStore(core),broker,id);while(await relay.once(run,routes)){} }

test.before(async()=>{
  for(const [service,db] of Object.entries({core,clinic,notification})){const [identity]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;assert.equal(identity.db,`p2_${service}_test`);assert.equal(identity.role,`p2_${service}`);const [marker]=await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;assert.equal(marker.marker,`pet-phase2-p1-test:${service}:v1`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',service==='core'?'backend/prisma/schema.prisma':`services/${service}/prisma/schema.prisma`],{env:{...process.env,DATABASE_URL:urls[service]},stdio:'pipe'});}
  process.env.JWT_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();process.env.JWT_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'}).toString();process.env.JWT_ISSUER='p3-core';process.env.JWT_AUDIENCE='pet-healthcare';
  for(const [name,id,role] of [['owner',owner,'owner'],['other',other,'owner'],['admin',admin,'admin'],['doctor',doctor,'doctor'],['staff',staff,'staff']]){await core.user.create({data:{id,role,fullName:`P3 ${name} ${run}`,passwordHash:'fixture',passwordSalt:'fixture',email:id+'@example.invalid',phone:'p3-phone-'+id}});tokens[name]=signToken(id,role);}
  pet=await core.pet.create({data:{ownerId:owner,name:'P3 pet '+run,species:'dog',breed:'P3 breed '+run,microchipId:'P3 chip '+run,allergies:[]}});otherPet=await core.pet.create({data:{ownerId:other,name:'Other P3 '+run,species:'cat',allergies:[]}});
  corePort=await freePort();coreUrl=`http://127.0.0.1:${corePort}`;
  for(let i=0;i<2;i++){const port=await freePort(),base=`http://127.0.0.1:${port}`;bases.push(base);await processHandle('services/clinic/dist/index.js',{DATABASE_URL:urls.clinic,PORT:String(port),CORE_SERVICE_URL:coreUrl,CLINIC_SERVICE_TOKEN:credential},async()=>{try{return(await fetch(base+'/health/ready',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});}
  await startCore();sync=new DirectorySync(coreUrl,credential);await declareTopology(broker,routes);declared=true;connection=await connect();channel=await connection.createConfirmChannel();channel.on('error',()=>{});
});
test.after(async()=>{
  try{await Promise.all(handles.map(h=>h.stop()));if(stopped){docker('up','-d','--wait','rabbitmq');stopped=false;}if(!connection){connection=await connect();channel=await connection.createConfirmChannel();}const retained=[];for(const q of (declared?[routes.notification,routes.notification+'.dlq',routes.clinic,routes.clinic+'.dlq']:[])){const state=await channel.checkQueue(q);if(state.messageCount)retained.push(q);else await channel.deleteQueue(q);}if(!retained.length)await channel.deleteExchange(routes.exchange);assert.deepEqual(retained,[],'Failed nonempty queues retained');assert.ok(handles.every(h=>!/fixture_only|postgresql:|amqp:\/\//.test(h.logs())),'No secrets in process logs');}
  finally{await channel?.close().catch(()=>{});await connection?.close().catch(()=>{});await close(server);await Promise.all([core.$disconnect(),clinic.$disconnect(),notification.$disconnect()]);}
});

test('two built Clinic processes: durable concurrent create, canonical retry, lost HTTP body, key reuse and actor scope',async()=>{
  status(await request('/api/appointments',{base:bases[0],method:'POST',key:randomUUID()}),422);status(await request('/api/medical-records',{base:bases[1],method:'POST',token:tokens.staff,key:randomUUID()}),422);status(await request('/api/appointments',{method:'POST',key:randomUUID(),body:[]}),422);
  const key=randomUUID(),body=appointment('08:00');const results=await Promise.all(Array.from({length:8},(_,i)=>request('/api/appointments',{base:i%2?bases[1]:coreUrl,method:'POST',body,key})));const rows=results.map(r=>status(r,201).appointment);assert.equal(new Set(rows.map(r=>r.id)).size,1);assert.equal(await clinic.appointment.count({where:{id:rows[0].id}}),1);assert.equal(await clinic.requestDedup.count({where:{actorId:owner,key}}),1);
  assert.deepEqual(status(await request('/api/appointments',{method:'POST',body:{...body,serviceName:' '+body.serviceName+' ',ownerNote:''},key}),201).appointment,rows[0]);
  status(await request('/api/appointments',{method:'POST',body:{...body,time:'08:01'},key}),409);
  status(await request('/api/appointments',{method:'POST',body,key,token:tokens.other}),403);
  const lost=randomUUID();await new Promise((resolve,reject)=>{const req=httpRequest(bases[1]+'/api/appointments',{method:'POST',headers:{Authorization:'Bearer '+tokens.owner,'Content-Type':'application/json','Idempotency-Key':lost}},res=>{try{assert.equal(res.statusCode,201);res.destroy();resolve();}catch(e){reject(e);}});req.on('error',reject);req.end(JSON.stringify(appointment('08:30')));});const recovered=status(await request('/api/appointments',{method:'POST',body:appointment('08:30'),key:lost}),201);assert.equal(recovered.appointment.id,(await clinic.requestDedup.findUniqueOrThrow({where:{actorId_operationType_key:{actorId:owner,operationType:'appointment.create',key:lost}}})).resourceId);
  assert.equal(await core.appointment.count({where:{petId:pet.id}}),0);
});
test('exam/Spa slot unique across replicas; cancelled slot frees; status/revision/undo/history and reschedule serialize',async()=>{
  const outcomes=await Promise.all([request('/api/appointments',{base:bases[0],method:'POST',key:randomUUID(),body:appointment('09:00')}),request('/api/appointments',{base:bases[1],method:'POST',key:randomUUID(),body:appointment('09:00',{type:'spa_bath'})})]);assert.deepEqual(outcomes.map(r=>r.status).sort(),[201,409]);let a=outcomes.find(r=>r.status===201).body.appointment;
  const raced=await Promise.all(bases.map(base=>request(`/api/appointments/${a.id}/status`,{base,method:'PATCH',token:tokens.admin,body:{status:'confirmed',expectedRevision:0}})));assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);a=raced.find(r=>r.status===200).body.appointment;a=await change(a,'checked_in');
  const hold=await clinic.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;const result=request(`/api/appointments/${a.id}/undo-status`,{base:bases[1],method:'POST',token:tokens.admin,body:{expectedRevision:a.statusRevision,reason:'Fixture undo'}});await until(async()=>{const [state]=await clinic.$queryRaw`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM appointments%FOR UPDATE%'`;return state.n>0;},'actual Clinic row lock waiter',2000);await tx.appointmentReservation.create({data:{operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:a.statusRevision,snapshot:{},state:'HELD'}});return{result};});status(await hold.result,409);status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(a)}),409);
  await clinic.appointmentReservation.updateMany({where:{appointmentId:a.id},data:{state:'RELEASED'}});
  a=status(await request(`/api/appointments/${a.id}/undo-status`,{method:'POST',token:tokens.admin,body:{expectedRevision:a.statusRevision,reason:'Fixture undo'}}),200).appointment;assert.equal(a.status,'confirmed');
  const history=status(await request(`/api/appointments/${a.id}/status-history`,{token:tokens.staff}),200);assert.equal(history.length,3);assert.equal(history[0].action,'undo');assert.ok(history[0].reversesId);status(await request(`/api/appointments/${a.id}/status-history`),403);
  a=status(await request(`/api/appointments/${a.id}/reschedule`,{method:'PATCH',body:{date,time:'09:15',expectedRevision:a.statusRevision}}),200).appointment;
  a=status(await request(`/api/appointments/${a.id}/cancel`,{method:'PATCH',body:{expectedRevision:a.statusRevision}}),200).appointment;assert.equal(a.status,'cancelled');await create('09:15',{type:'spa_combo'});
});
test('medical creation and appointment completion/history/outbox/dedup atomic; two-process replay and real SQL fault rollback',async()=>{
  let a=await create('10:00');a=await change(a,'confirmed');a=await change(a,'checked_in');const key=randomUUID(),body=record(a);
  const results=await Promise.all(bases.map(base=>request('/api/medical-records',{base,method:'POST',token:tokens.doctor,key,body})));const records=results.map(r=>status(r,201).record);assert.equal(records[0].id,records[1].id);status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key,body:{...body,visitDate:new Date(Date.now()+7*3600000+2*86400000).toISOString().slice(0,10)}}),409);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:a.id}})).status,'completed');assert.equal(await clinic.bookingStatusEvent.count({where:{bookingId:a.id,action:'medical_completed'}}),1);assert.equal(await clinic.medicalRecord.count({where:{appointmentId:a.id}}),1);status(await request(`/api/appointments/${a.id}/undo-status`,{method:'POST',token:tokens.admin,body:{expectedRevision:3,reason:'Blocked medical'}}),409);
  let failed=await create('10:30');failed=await change(failed,'confirmed');failed=await change(failed,'checked_in');const fault='p3_fault_'+run.replaceAll('-','');await clinic.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" ADD CONSTRAINT "${fault}" CHECK(envelope->'payload'->>'relatedAppointmentId' IS DISTINCT FROM '${failed.id}') NOT VALID`);
  const failedKey=randomUUID();try{status(await request('/api/medical-records',{method:'POST',token:tokens.staff,key:failedKey,body:record(failed)}),503);assert.equal(await clinic.medicalRecord.count({where:{appointmentId:failed.id}}),0);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:failed.id}})).status,'checked_in');assert.equal(await clinic.bookingStatusEvent.count({where:{bookingId:failed.id,action:'medical_completed'}}),0);assert.equal(await clinic.requestDedup.count({where:{key:failedKey}}),0);}finally{await clinic.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" DROP CONSTRAINT "${fault}"`);}
  status(await request('/api/medical-records',{method:'POST',token:tokens.staff,key:failedKey,body:record(failed,{petId:otherPet.id})}),422);
  status(await request('/api/medical-records',{method:'POST',token:tokens.staff,key:randomUUID(),body:record(null,{weightKg:-1})}),422);
  status(await request('/api/medical-records',{method:'POST',token:tokens.staff,key:randomUUID(),body:record(null,{visitDate:'2026-02-30'})}),422);
  status(await request(`/api/medical-records/${records[0].id}`,{method:'PATCH',token:tokens.admin,body:{petId:otherPet.id}}),422);
  const updated=status(await request(`/api/medical-records/${records[0].id}`,{method:'PATCH',token:tokens.admin,body:{title:'Updated P3 '+run}}),200).record;assert.equal(updated.weightKg,4.25);
  await clinic.appointmentReservation.create({data:{operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:3,snapshot:{},state:'INVOICED',invoiceId:randomUUID()}});
  for(const method of ['PATCH','DELETE'])status(await request(`/api/medical-records/${records[0].id}`,{method,token:tokens.admin,body:method==='PATCH'?{title:'Blocked'}:undefined}),409);
});
test('every medical read/write scopes through Core; pagination/filter/count/related and owner redaction; images lifecycle',async()=>{
  const foreign=status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(null,{petId:otherPet.id,title:'Foreign '+run})}),201).record;
  const ownerPage=status(await request(`/api/medical-records?petId=${pet.id}&pageSize=1`),200);assert.equal(ownerPage.items.length,1);assert.ok(ownerPage.pagination.total>=1);assert.ok(!JSON.stringify(ownerPage).includes('P3_PRIVATE_MARKER'));assert.ok(!JSON.stringify(ownerPage).includes('password'));assert.ok(ownerPage.related.pets.every(p=>p.ownerId===owner));status(await request(`/api/medical-records?petId=${otherPet.id}`),403);status(await request(`/api/medical-records/${foreign.id}`,{method:'DELETE'}),403);
  for(const body of [{imageUrl:'data:image/png;base64,AA==',mimeType:'image/png'},{imageUrl:'data:image/svg+xml;base64,PHN2Zz4=',mimeType:'image/svg+xml'}])status(await request('/api/medical-records/images',{method:'POST',token:tokens.staff,body:{petId:pet.id,title:'Rejected '+run,...body}}),422);
  const image=status(await request('/api/medical-records/images',{method:'POST',token:tokens.staff,body:{petId:pet.id,title:'Image '+run,imageUrl:'data:image/png;base64,iVBORw0KGgo=',mimeType:'image/png'}}),201).image;assert.ok(!('ownerId'in image));
  const images=status(await request(`/api/medical-records/images?petId=${pet.id}`),200);assert.equal(images.pagination.total,1);assert.equal(images.items[0].id,image.id);assert.ok(images.related.pets.some(p=>p.id===pet.id));status(await request('/api/medical-records/images',{method:'POST',body:{petId:pet.id}}),403);status(await request(`/api/medical-records/images/${image.id}`,{method:'DELETE',token:tokens.doctor}),204);status(await request(`/api/medical-records/${foreign.id}`,{method:'DELETE',token:tokens.admin}),204);
  const all=status(await request(`/api/appointments?petId=${pet.id}&pageSize=1&statusGroup=completed`),200);assert.equal(all.items[0].status,'completed');assert.ok(all.counts.pending>=1);assert.ok(all.counts.completed>=1);assert.equal(all.related.appointments.length,0);assert.ok(all.related.pets.every(p=>p.id===pet.id));
  status(await request('/api/appointments?petId='+encodeURIComponent(' '+pet.id+' ')),200);
  const calendar=status(await request('/api/appointments/calendar?month='+date.slice(0,7)),200);assert.ok(calendar[date]>=1);status(await request('/api/appointments?pageSize=101'),422);status(await request('/api/appointments?date=2026-02-30'),422);
  const dashboard=status(await request('/api/bootstrap?view=dashboard'),200);assert.ok(dashboard.appointments.some(a=>a.petId===pet.id));assert.ok(dashboard.medicalRecords.some(r=>r.petId===pet.id));assert.equal(dashboard.summary.totals.appointments,await clinic.appointment.count({where:{ownerId:owner}}));assert.ok(!JSON.stringify(dashboard).includes('P3_PRIVATE_MARKER'));status(await request('/api/bootstrap',{base:bases[0]}),404);
  // P4 now owns this flow and rejects missing durable request keys.
  status(await request('/api/invoices',{method:'POST',token:tokens.admin,body:{type:'appointment',relatedId:all.items[0].id,subtotal:100000}}),422);
});
test('directory snapshot then durable catch-up; search lag, full long names/email/chip, version and tombstone guards',async()=>{
  const long='x'.repeat(250)+'P3_LONG_'+run;let changed=false;const counts=await backfill(clinic,sync,async kind=>{if(kind==='pet'&&!changed&&await clinic.directoryProjection.findUnique({where:{kind_id:{kind:'pet',id:pet.id}}})){changed=true;const updated=status(await request(`/api/pets/${pet.id}`,{method:'PATCH',body:{name:'P3 rename '+run}}),200).pet;assert.equal(updated.directoryVersion,2);await core.pet.update({where:{id:pet.id},data:{name:long}});}});assert.ok(counts.pet>=2);assert.ok(changed);
  const before=status(await request('/api/appointments?q=P3_LONG_'+run),200);assert.equal(before.pagination.total,0);
  const env={BROKER_URL:broker,BROKER_PREFIX:prefix,DATABASE_URL:urls.clinic,CORE_SERVICE_URL:coreUrl,CLINIC_SERVICE_TOKEN:credential};await processHandle('services/clinic/dist/worker.js',env);
  await relayCore(pet.id);await until(async()=> (await clinic.directoryProjection.findUnique({where:{kind_id:{kind:'pet',id:pet.id}}}))?.displayName===long,'directory caught up');
  for(const q of ['P3_LONG_'+run,pet.microchipId,owner+'@example.invalid']){const page=status(await request('/api/appointments?q='+encodeURIComponent(q)+'&pageSize=1'),200);assert.ok(page.pagination.total>=1);assert.equal(page.items.length,1);}
  const newest=await clinic.directoryProjection.findUniqueOrThrow({where:{kind_id:{kind:'pet',id:pet.id}}});assert.equal(newest.sourceVersion,3);
  const event=(version,deletedAt=null)=>JSON.stringify({eventId:randomUUID(),eventType:'directory.pet-upserted.v1',schemaVersion:1,producer:'core',aggregateType:'pet',aggregateId:pet.id,aggregateVersion:version,occurredAt:new Date().toISOString(),correlationId:run,payload:{id:pet.id,sourceVersion:version,displayName:'Old projection',ownerId:other,species:'dog',deletedAt}});
  await new ClinicInbox(clinic).apply(event(1));assert.equal((await clinic.directoryProjection.findUniqueOrThrow({where:{kind_id:{kind:'pet',id:pet.id}}})).displayName,long);
  // Forged ownership in a projection never grants the other owner write access.
  await clinic.directoryProjection.update({where:{kind_id:{kind:'pet',id:otherPet.id}},data:{ownerId:owner}});status(await request('/api/appointments',{method:'POST',key:randomUUID(),body:appointment('11:00',{petId:otherPet.id})}),403);
  const tombId=randomUUID();const old=JSON.parse(event(5));old.aggregateId=tombId;old.payload.id=tombId;old.payload.deletedAt=new Date().toISOString();await new ClinicInbox(clinic).apply(JSON.stringify(old));const replay={...old,eventId:randomUUID(),aggregateVersion:4,payload:{...old.payload,sourceVersion:4,deletedAt:null}};await new ClinicInbox(clinic).apply(JSON.stringify(replay));assert.ok((await clinic.directoryProjection.findUniqueOrThrow({where:{kind_id:{kind:'pet',id:tombId}}})).deletedAt);
  const pending=await core.outboxEvent.findMany({where:{envelope:{path:['aggregateId'],equals:pet.id}}});assert.ok(pending.every(e=>!JSON.stringify(e.envelope).includes('password')));
  const removed=await core.pet.create({data:{ownerId:owner,name:'Removed fixture',species:'cat',allergies:[]}});const oldEvent=await core.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:removed.id}}});await core.pet.delete({where:{id:removed.id}});
  const hydrated=new ClinicInbox(clinic,(kind,p)=>sync.hydrate(kind,p));await hydrated.apply(JSON.stringify(oldEvent.envelope));const deleted=await clinic.directoryProjection.findUniqueOrThrow({where:{kind_id:{kind:'pet',id:removed.id}}});assert.ok(deleted.deletedAt);assert.equal(deleted.sourceVersion,2);await relayCore(removed.id);
});
test('missing/invalid JWT, current role withdrawal, Core outage and recovery fail closed on protected Clinic paths',async()=>{
  status(await request('/api/appointments',{token:null}),401);status(await request('/api/appointments',{token:'invalid'}),401);
  const actor=await core.user.create({data:{role:'staff',passwordHash:'fixture',passwordSalt:'fixture',fullName:'Withdraw '+run}}),old=signToken(actor.id,'staff');await core.user.update({where:{id:actor.id},data:{role:'owner'}});status(await request('/api/medical-records',{token:old}),403);
  const privateKey=randomUUID(),privateBody=record(null);status(await request('/api/medical-records',{method:'POST',token:tokens.staff,key:privateKey,body:privateBody}),201);await core.user.update({where:{id:staff},data:{role:'owner'}});status(await request('/api/medical-records',{method:'POST',token:signToken(staff,'owner'),key:privateKey,body:privateBody}),403);await core.user.update({where:{id:staff},data:{role:'staff'}});
  status(await request('/internal/directory/export?kind=pet'),401);
  await close(server);server=undefined;try{for(const path of ['/api/appointments','/api/appointments/calendar?month='+date.slice(0,7),'/api/medical-records','/api/medical-records/images'])status(await request(path,{base:bases[0]}),503);const key=randomUUID();status(await request('/api/appointments',{base:bases[1],method:'POST',key,body:appointment('11:30')}),503);assert.equal(await clinic.requestDedup.count({where:{key}}),0);const completed=await core.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:pet.id}}});assert.equal(await new ClinicInbox(clinic,(kind,p)=>sync.hydrate(kind,p)).apply(JSON.stringify(completed.envelope)),false);}finally{await startCore();}
  status(await request('/api/appointments'),200);
});
test('Clinic API commit survives broker outage; built relay/inbox deliver notification exactly once after recovery', {timeout:60000},async()=>{
  await channel.close();await connection.close();channel=undefined;connection=undefined;docker('stop','rabbitmq');stopped=true;
  let a;try{a=await create('12:00');status(await request(`/api/appointments/${a.id}/reminder`,{method:'POST',token:tokens.staff}),201);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:a.id}})).status,'pending');assert.equal(await core.appointment.count({where:{id:a.id}}),0);}finally{docker('up','-d','--wait','rabbitmq');stopped=false;connection=await connect();channel=await connection.createConfirmChannel();channel.on('error',()=>{});}
  const consumer=await processHandle('services/notification/dist/worker.js',{BROKER_URL:broker,BROKER_PREFIX:prefix,DATABASE_URL:urls.notification});
  const events=await clinic.outboxEvent.findMany({where:{envelope:{path:['payload','relatedAppointmentId'],equals:a.id}}});assert.equal(events.length,2);
  await until(async()=>{for(const e of events)if(!await notification.notification.findUnique({where:{id:e.envelope.payload.notificationId}}))return false;return true;},'notification catch-up');
  for(const e of events){await publishConfirmed(channel,routes.exchange,e.envelope.eventType,Buffer.from(JSON.stringify(e.envelope)),{messageId:e.id,contentType:'application/json'});}
  await waitForQueueIdle([routes.notification,routes.clinic]);for(const e of events)assert.equal(await notification.notification.count({where:{id:e.envelope.payload.notificationId}}),1);
  assert.ok(!JSON.stringify(events).includes('P3_PRIVATE_MARKER'));
  status(await request(`/api/appointments/${a.id}/reminder`,{method:'POST'}),403);
});
test('AQ-15 medical record audit: create/update/delete revisions in the same transaction, staff-only, kept after delete, immutable',async()=>{
  const created=status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{title:'Audit '+run})}),201).record;
  status(await request(`/api/medical-records/${created.id}`,{method:'PATCH',token:tokens.admin,body:{title:'Audit edited '+run,diagnosis:'Revised diagnosis'}}),200);
  // A rejected change (reassignment, 422) rolls back with no revision.
  status(await request(`/api/medical-records/${created.id}`,{method:'PATCH',token:tokens.admin,body:{petId:otherPet.id}}),422);
  status(await request(`/api/medical-records/${created.id}/history`,{token:tokens.owner}),403);
  let history=status(await request(`/api/medical-records/${created.id}/history`,{token:tokens.staff}),200).items;
  assert.deepEqual(history.map(r=>r.action),['create','update']);
  assert.equal(history[0].before,null);assert.equal(history[0].after.title,'Audit '+run);assert.equal(history[0].actorId,doctor);assert.equal(history[0].actorRole,'doctor');
  assert.equal(history[1].before.title,'Audit '+run);assert.equal(history[1].after.title,'Audit edited '+run);assert.equal(history[1].after.diagnosis,'Revised diagnosis');assert.equal(history[1].actorId,admin);
  status(await request(`/api/medical-records/${created.id}`,{method:'DELETE',token:tokens.admin}),204);
  history=status(await request(`/api/medical-records/${created.id}/history`,{token:tokens.admin}),200).items;
  assert.deepEqual(history.map(r=>r.action),['create','update','delete']);assert.equal(history[2].after,null);assert.equal(history[2].before.title,'Audit edited '+run);
  status(await request(`/api/medical-records/${randomUUID()}/history`,{token:tokens.admin}),404);
  for(const sql of ['UPDATE medical_record_revisions SET actor_id=\'forged\' WHERE record_id=$1','DELETE FROM medical_record_revisions WHERE record_id=$1'])
    await assert.rejects(clinic.$executeRawUnsafe(sql,created.id),/MEDICAL_RECORD_REVISION_IMMUTABLE/);
  assert.equal(await clinic.medicalRecordRevision.count({where:{recordId:created.id}}),3);
});
test('AQ-05 password change revokes earlier sessions on Core and on direct Clinic calls (directory SESSION_REVOKED)',async()=>{
  const id=randomUUID();await core.user.create({data:{id,role:'staff',fullName:'AQ-05 staff '+run,passwordHash:'fixture',passwordSalt:'fixture'}});
  const old=signToken(id,'staff'),iat=JSON.parse(Buffer.from(old.split('.')[1],'base64url').toString()).iat;
  for(const base of [coreUrl,bases[0]])status(await request('/api/appointments?pageSize=1',{base,token:old}),200);
  await core.user.update({where:{id},data:{passwordChangedAt:new Date((iat+1)*1000)}});
  for(const base of [coreUrl,bases[0]]){const r=await request('/api/appointments?pageSize=1',{base,token:old});assert.equal(r.status,401,base+' '+JSON.stringify(r.body));assert.match(r.body.error,/password was changed/i);}
  await sleep(1100);const fresh=signToken(id,'staff');
  for(const base of [coreUrl,bases[0]])status(await request('/api/appointments?pageSize=1',{base,token:fresh}),200);
});
