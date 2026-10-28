import test from 'node:test';
import {topologyQueues,waitForQueueIdle} from './test-project.mjs';
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
import {readFileSync} from 'node:fs';
import {blobTestEnv} from './blob-test.mjs';
import {blobStoreFromEnv} from '../../services/clinic/dist/blobStore.js';
import {drainBlobCleanup,imageRetentionMs} from '../../services/clinic/dist/blobCleanup.js';
import {liftAppointmentCapacity} from './appointment-capacity.mjs';

assert.equal(process.env.PHASE2_TEST_CONFIRM,'pet-phase2-p1-test','Use guarded phase2:test:clinic');
Object.assign(process.env,blobTestEnv);// spawned Clinic processes use the dedicated test bucket
const blobs=blobStoreFromEnv();
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
const record=(a,extras={})=>({petId:pet.id,appointmentId:a?.id,title:'P3 medical '+run,visitDate:date,diagnosis:'Synthetic diagnosis',treatment:'Synthetic treatment',internalNote:'P3_PRIVATE_MARKER',weightKg:4.25,...extras});
async function connect(){let c;await until(async()=>{try{c=await amqp.connect(broker,{timeout:1000});return true;}catch{return false;}},'broker');c.on('error',()=>{});return c;}
const docker=(...args)=>execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml',...args],{stdio:'pipe',timeout:30000});
async function relayCore(id){const relay=new CoreRelay(new RuntimeOutboxStore(core),broker,id);while(await relay.once(run,routes)){} }

test.before(async()=>{
  for(const [service,db] of Object.entries({core,clinic,notification})){const [identity]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;assert.equal(identity.db,`p2_${service}_test`);assert.equal(identity.role,`p2_${service}`);const [marker]=await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;assert.equal(marker.marker,`pet-phase2-p1-test:${service}:v1`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',service==='core'?'backend/prisma/schema.prisma':`services/${service}/prisma/schema.prisma`],{env:{...process.env,DATABASE_URL:urls[service]},stdio:'pipe'});}
  process.env.JWT_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();process.env.JWT_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'}).toString();process.env.JWT_ISSUER='p3-core';process.env.JWT_AUDIENCE='pet-healthcare';
  for(const [name,id,role] of [['owner',owner,'owner'],['other',other,'owner'],['admin',admin,'admin'],['doctor',doctor,'doctor'],['staff',staff,'staff']]){await core.user.create({data:{id,role,fullName:`P3 ${name} ${run}`,passwordHash:'fixture',passwordSalt:'fixture',email:id+'@example.invalid',phone:'p3-phone-'+id}});tokens[name]=signToken(id,role);}
  await liftAppointmentCapacity(clinic);
  pet=await core.pet.create({data:{ownerId:owner,name:'P3 pet '+run,species:'dog',breed:'P3 breed '+run,microchipId:'P3 chip '+run,allergies:[]}});otherPet=await core.pet.create({data:{ownerId:other,name:'Other P3 '+run,species:'cat',allergies:[]}});
  corePort=await freePort();coreUrl=`http://127.0.0.1:${corePort}`;
  for(let i=0;i<2;i++){const port=await freePort(),base=`http://127.0.0.1:${port}`;bases.push(base);await processHandle('services/clinic/dist/index.js',{DATABASE_URL:urls.clinic,PORT:String(port),CORE_SERVICE_URL:coreUrl,CLINIC_SERVICE_TOKEN:credential},async()=>{try{return(await fetch(base+'/health/ready',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});}
  await startCore();sync=new DirectorySync(coreUrl,credential);await declareTopology(broker,routes);declared=true;connection=await connect();channel=await connection.createConfirmChannel();channel.on('error',()=>{});
});
test.after(async()=>{
  try{await Promise.all(handles.map(h=>h.stop()));if(stopped){docker('up','-d','--wait','rabbitmq');stopped=false;}if(!connection){connection=await connect();channel=await connection.createConfirmChannel();}const retained=[];for(const q of (declared?topologyQueues(routes,[routes.notification,routes.identity,routes.clinic]):[])){const state=await channel.checkQueue(q);if(state.messageCount)retained.push(q);else await channel.deleteQueue(q);}if(!retained.length)await channel.deleteExchange(routes.exchange);assert.deepEqual(retained,[],'Failed nonempty queues retained');assert.ok(handles.every(h=>!/fixture_only|postgresql:|amqp:\/\//.test(h.logs())),'No secrets in process logs');}
  finally{await channel?.close().catch(()=>{});await connection?.close().catch(()=>{});await close(server);await Promise.all([core.$disconnect(),clinic.$disconnect(),notification.$disconnect()]);}
});

test('two built Clinic processes: durable concurrent create, canonical retry, lost HTTP body, key reuse and actor scope',async()=>{
  status(await request('/api/appointments',{base:bases[0],method:'POST',key:randomUUID()}),422);status(await request('/api/medical-records',{base:bases[1],method:'POST',token:tokens.doctor,key:randomUUID()}),422);status(await request('/api/appointments',{method:'POST',key:randomUUID(),body:[]}),422);
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
  const hold=await clinic.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;const result=request(`/api/appointments/${a.id}/undo-status`,{base:bases[1],method:'POST',token:tokens.admin,body:{expectedRevision:a.statusRevision,reason:'Fixture undo'}});await until(async()=>{const [state]=await clinic.$queryRaw`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM appointments%FOR UPDATE%'`;return state.n>0;},'actual Clinic row lock waiter',2000);await tx.appointmentReservation.create({data:{operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:a.statusRevision,snapshot:{},state:'HELD'}});return{result};});status(await hold.result,409);status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(a,{doctorId:doctor})}),409);
  await clinic.appointmentReservation.updateMany({where:{appointmentId:a.id},data:{state:'RELEASED'}});
  a=status(await request(`/api/appointments/${a.id}/undo-status`,{method:'POST',token:tokens.admin,body:{expectedRevision:a.statusRevision,reason:'Fixture undo'}}),200).appointment;assert.equal(a.status,'confirmed');
  const history=status(await request(`/api/appointments/${a.id}/status-history`,{token:tokens.staff}),200);assert.equal(history.length,3);assert.equal(history[0].action,'undo');assert.ok(history[0].reversesId);status(await request(`/api/appointments/${a.id}/status-history`),403);
  a=status(await request(`/api/appointments/${a.id}/reschedule`,{method:'PATCH',body:{date,time:'15:00',expectedRevision:a.statusRevision}}),200).appointment;
  a=status(await request(`/api/appointments/${a.id}/cancel`,{method:'PATCH',body:{expectedRevision:a.statusRevision}}),200).appointment;assert.equal(a.status,'cancelled');await create('15:00',{type:'spa_combo'});
});
test('medical creation and appointment completion/history/outbox/dedup atomic; two-process replay and real SQL fault rollback',async()=>{
  let a=await create('10:00');a=await change(a,'confirmed');a=await change(a,'checked_in');const key=randomUUID(),body=record(a);
  const results=await Promise.all(bases.map(base=>request('/api/medical-records',{base,method:'POST',token:tokens.doctor,key,body})));const records=results.map(r=>status(r,201).record);assert.equal(records[0].id,records[1].id);status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key,body:{...body,visitDate:new Date(Date.now()+7*3600000+2*86400000).toISOString().slice(0,10)}}),409);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:a.id}})).status,'completed');assert.equal(await clinic.bookingStatusEvent.count({where:{bookingId:a.id,action:'medical_completed'}}),1);assert.equal(await clinic.medicalRecord.count({where:{appointmentId:a.id}}),1);status(await request(`/api/appointments/${a.id}/undo-status`,{method:'POST',token:tokens.admin,body:{expectedRevision:3,reason:'Blocked medical'}}),409);
  let failed=await create('10:30');failed=await change(failed,'confirmed');failed=await change(failed,'checked_in');const fault='p3_fault_'+run.replaceAll('-','');await clinic.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" ADD CONSTRAINT "${fault}" CHECK(envelope->'payload'->>'relatedAppointmentId' IS DISTINCT FROM '${failed.id}') NOT VALID`);
  const failedKey=randomUUID();try{assert.equal(status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:failedKey,body:record(failed)}),500).code,'INTERNAL_ERROR');assert.equal(await clinic.medicalRecord.count({where:{appointmentId:failed.id}}),0);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:failed.id}})).status,'checked_in');assert.equal(await clinic.bookingStatusEvent.count({where:{bookingId:failed.id,action:'medical_completed'}}),0);assert.equal(await clinic.requestDedup.count({where:{key:failedKey}}),0);}finally{await clinic.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" DROP CONSTRAINT "${fault}"`);}
  status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:failedKey,body:record(failed,{petId:otherPet.id})}),422);
  status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{weightKg:-1})}),422);
  status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{visitDate:'2026-02-30'})}),422);
  status(await request(`/api/medical-records/${records[0].id}`,{method:'PATCH',token:tokens.admin,body:{petId:otherPet.id,expectedRevision:0}}),422);
  const updated=status(await request(`/api/medical-records/${records[0].id}`,{method:'PATCH',token:tokens.admin,body:{title:'Updated P3 '+run,expectedRevision:0}}),200).record;assert.equal(updated.weightKg,4.25);assert.equal(updated.revision,1);
  await clinic.appointmentReservation.create({data:{operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:3,snapshot:{},state:'INVOICED',invoiceId:randomUUID()}});
  for(const method of ['PATCH','DELETE'])status(await request(`/api/medical-records/${records[0].id}${method==='DELETE'?'?expectedRevision=1':''}`,{method,token:tokens.admin,body:method==='PATCH'?{title:'Blocked',expectedRevision:1}:undefined}),409);
});
test('every medical read/write scopes through Core; pagination/filter/count/related and owner redaction; images lifecycle',async()=>{
  const foreign=status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(null,{petId:otherPet.id,title:'Foreign '+run,doctorId:doctor})}),201).record;
  const ownerPage=status(await request(`/api/medical-records?petId=${pet.id}&pageSize=1`),200);assert.equal(ownerPage.items.length,1);assert.ok(ownerPage.pagination.total>=1);assert.ok(!JSON.stringify(ownerPage).includes('P3_PRIVATE_MARKER'));assert.ok(!JSON.stringify(ownerPage).includes('password'));assert.ok(ownerPage.related.pets.every(p=>p.ownerId===owner));status(await request(`/api/medical-records?petId=${otherPet.id}`),403);status(await request(`/api/medical-records/${foreign.id}?expectedRevision=0`,{method:'DELETE'}),403);
  for(const body of [{imageUrl:'data:image/png;base64,AA==',mimeType:'image/png'},{imageUrl:'data:image/svg+xml;base64,PHN2Zz4=',mimeType:'image/svg+xml'}])status(await request('/api/medical-records/images',{method:'POST',token:tokens.doctor,body:{petId:pet.id,title:'Rejected '+run,...body}}),422);
  const image=status(await request('/api/medical-records/images',{method:'POST',token:tokens.doctor,body:{petId:pet.id,title:'Image '+run,imageUrl:'data:image/png;base64,iVBORw0KGgo=',mimeType:'image/png'}}),201).image;assert.ok(!('ownerId'in image));
  // AQ-09 Claim Check: the row holds a claim, the bytes live in the bucket, the response carries a valet key.
  assert.ok(!('imageUrl'in image)&&!('storageKey'in image)&&image.sizeBytes===8&&image.mimeType==='image/png'&&typeof image.urlExpiresAt==='string');
  const stored=await clinic.medicalImage.findUniqueOrThrow({where:{id:image.id}});assert.equal(stored.imageUrl,null);assert.equal(stored.storageKey,'images/'+image.id);assert.equal(stored.sizeBytes,8);assert.match(stored.sha256,/^[0-9a-f]{64}$/);
  const fetched=await fetch(image.url);assert.equal(fetched.status,200);assert.equal(fetched.headers.get('content-type'),'image/png');assert.deepEqual([...Buffer.from(await fetched.arrayBuffer())],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  assert.equal((await fetch(image.url.replace(/(X-Amz-Signature=)(.)/,(_,p,c)=>p+(c==='0'?'1':'0')))).status,403);
  const images=status(await request(`/api/medical-records/images?petId=${pet.id}`),200);assert.equal(images.pagination.total,1);assert.equal(images.items[0].id,image.id);assert.ok(!('imageUrl'in images.items[0])&&!('storageKey'in images.items[0])&&!('sha256'in images.items[0])&&typeof images.items[0].url==='string');assert.equal((await fetch(images.items[0].url)).status,200);assert.ok(images.related.pets.some(p=>p.id===pet.id));status(await request('/api/medical-records/images',{method:'POST',body:{petId:pet.id}}),403);status(await request(`/api/medical-records/images/${image.id}`,{method:'DELETE',token:tokens.doctor}),204);
  // AQ-09 retention: a tombstone hidden from lists, its object kept and its cleanup claim due when the window ends; every step logged.
  {const gone=status(await request(`/api/medical-records/images?petId=${pet.id}`),200);assert.equal(gone.pagination.total,0);const tomb=await clinic.medicalImage.findUniqueOrThrow({where:{id:image.id}});assert.ok(tomb.deletedAt);assert.equal(tomb.deletedBy,doctor);const claim=await clinic.blobCleanup.findUniqueOrThrow({where:{storageKey:stored.storageKey}});assert.ok(Math.abs(claim.nextAttemptAt.getTime()-tomb.deletedAt.getTime()-imageRetentionMs())<1000);assert.equal((await fetch(blobs.signedGetUrl(stored.storageKey).url)).status,200,'the object is kept during the window');status(await request(`/api/medical-records/images/${image.id}`,{method:'DELETE',token:tokens.doctor}),404);status(await request(`/api/medical-records/images/${image.id}/restore`,{method:'POST',token:tokens.staff}),403);assert.match(status(await request(`/api/medical-records/images/${image.id}/restore`,{method:'POST',token:tokens.doctor}),403).error,/khôi phục/);status(await request(`/api/medical-records/images/${image.id}/restore`,{method:'POST',token:tokens.admin}),204);assert.equal(status(await request(`/api/medical-records/images?petId=${pet.id}`),200).pagination.total,1);assert.equal(await clinic.blobCleanup.count({where:{storageKey:stored.storageKey}}),0);status(await request(`/api/medical-records/images/${image.id}/restore`,{method:'POST',token:tokens.admin}),404);status(await request(`/api/medical-records/images/${image.id}`,{method:'DELETE',token:tokens.admin}),204);assert.deepEqual(await drainBlobCleanup(clinic,blobs,{now:new Date()}),{due:0,removed:0,purged:0},'nothing is due inside the window');const later=new Date(Date.now()+imageRetentionMs()+60000);const drained=await drainBlobCleanup(clinic,blobs,{now:later});assert.ok(drained.removed>=1&&drained.purged>=1);assert.equal(await clinic.medicalImage.count({where:{id:image.id}}),0);assert.equal(await clinic.blobCleanup.count({where:{storageKey:stored.storageKey}}),0);assert.equal((await fetch(blobs.signedGetUrl(stored.storageKey).url)).status,404);status(await request(`/api/medical-records/images/${image.id}/restore`,{method:'POST',token:tokens.admin}),404);const log=await clinic.medicalImageDeletion.findMany({where:{imageId:image.id},orderBy:[{at:'asc'},{id:'asc'}]});assert.deepEqual(log.map(l=>[l.action,l.actorRole]),[['delete','doctor'],['restore','admin'],['delete','admin'],['purge','system']]);assert.ok(log.every(l=>l.storageKey===stored.storageKey&&l.sha256===stored.sha256&&l.petId===pet.id));await assert.rejects(clinic.medicalImageDeletion.update({where:{id:log[0].id},data:{action:'restore'}}),/MEDICAL_IMAGE_DELETION_IMMUTABLE/);await assert.rejects(clinic.medicalImageDeletion.delete({where:{id:log[0].id}}),/MEDICAL_IMAGE_DELETION_IMMUTABLE/);}
  // Restore and purge take the same row lock: a purge that arrives while a restore holds the row waits, then sees a live image and keeps its object.
  {const raced=status(await request('/api/medical-records/images',{method:'POST',token:tokens.doctor,body:{petId:pet.id,title:'Race '+run,imageUrl:'data:image/png;base64,iVBORw0KGgo=',mimeType:'image/png'}}),201).image;status(await request(`/api/medical-records/images/${raced.id}`,{method:'DELETE',token:tokens.doctor}),204);const key='images/'+raced.id,order=[];let release;const gate=new Promise(r=>{release=r;});const restoring=clinic.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM medical_images WHERE id=${raced.id} FOR UPDATE`;order.push('restore-locked');await gate;await tx.medicalImage.update({where:{id:raced.id},data:{deletedAt:null,deletedBy:null}});await tx.blobCleanup.deleteMany({where:{storageKey:key}});order.push('restored');},{timeout:15000});await new Promise(r=>setTimeout(r,100));const purging=drainBlobCleanup(clinic,blobs,{now:new Date(Date.now()+imageRetentionMs()+60000)}).then(result=>{order.push('drained');return result;});await new Promise(r=>setTimeout(r,400));assert.deepEqual(order,['restore-locked'],'the purge waits for the row lock');release();await restoring;await purging;assert.deepEqual(order,['restore-locked','restored','drained']);assert.equal((await clinic.medicalImage.findUniqueOrThrow({where:{id:raced.id}})).deletedAt,null);assert.equal((await fetch(blobs.signedGetUrl(key).url)).status,200,'a restored image keeps its object');assert.equal(await clinic.blobCleanup.count({where:{storageKey:key}}),0);}status(await request(`/api/medical-records/${foreign.id}?expectedRevision=0`,{method:'DELETE',token:tokens.admin}),204);
  const all=status(await request(`/api/appointments?petId=${pet.id}&pageSize=1&statusGroup=completed`),200);assert.equal(all.items[0].status,'completed');assert.ok(all.counts.pending>=1);assert.ok(all.counts.completed>=1);assert.equal(all.related.appointments.length,0);assert.ok(all.related.pets.every(p=>p.id===pet.id));
  status(await request('/api/appointments?petId='+encodeURIComponent(' '+pet.id+' ')),200);
  const calendar=status(await request('/api/appointments/calendar?month='+date.slice(0,7)),200);assert.ok(calendar[date]>=1);status(await request('/api/appointments?pageSize=101'),422);status(await request('/api/appointments?date=2026-02-30'),422);
  const dashboard=status(await request('/api/dashboard/clinic'),200);assert.ok(dashboard.appointments.some(a=>a.petId===pet.id));assert.ok(dashboard.medicalRecords.some(r=>r.petId===pet.id));assert.equal(dashboard.summary.totals.appointments,await clinic.appointment.count({where:{ownerId:owner}}));assert.ok(!JSON.stringify(dashboard).includes('P3_PRIVATE_MARKER'));
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
  const privateKey=randomUUID(),privateBody=record(null);status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:privateKey,body:privateBody}),201);await core.user.update({where:{id:doctor},data:{role:'owner'}});status(await request('/api/medical-records',{method:'POST',token:signToken(doctor,'owner'),key:privateKey,body:privateBody}),403);await core.user.update({where:{id:doctor},data:{role:'doctor'}});
  // AQ-05 over real Core + Clinic: staff reads medical records and history but cannot write them or images.
  {const refused=status(await request('/api/medical-records',{method:'POST',token:tokens.staff,key:randomUUID(),body:record(null)}),403);assert.match(refused.error,/bác sĩ hoặc quản trị viên/);status(await request('/api/medical-records/images',{method:'POST',token:tokens.staff,body:{petId:pet.id,title:'Staff '+run,imageUrl:'data:image/png;base64,iVBORw0KGgo=',mimeType:'image/png'}}),403);status(await request(`/api/medical-records?petId=${pet.id}`,{token:tokens.staff}),200);}
  status(await request('/internal/directory/export?kind=pet'),401);
  await close(server);server=undefined;try{for(const path of ['/api/appointments','/api/appointments/calendar?month='+date.slice(0,7),'/api/medical-records','/api/medical-records/images'])status(await request(path,{base:bases[0]}),503);const key=randomUUID();status(await request('/api/appointments',{base:bases[1],method:'POST',key,body:appointment('11:30')}),503);assert.equal(await clinic.requestDedup.count({where:{key}}),0);const completed=await core.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:pet.id}}});assert.equal(await new ClinicInbox(clinic,(kind,p)=>sync.hydrate(kind,p)).apply(JSON.stringify(completed.envelope)),false);}finally{await startCore();}
  status(await request('/api/appointments'),200);
});
test('Clinic API commit survives broker outage; built relay/inbox deliver notification exactly once after recovery', {timeout:60000},async()=>{
  await channel.close();await connection.close();channel=undefined;connection=undefined;docker('stop','rabbitmq');stopped=true;
  let a;try{a=await create('12:00');status(await request(`/api/appointments/${a.id}/reminder`,{method:'POST',token:tokens.staff}),201);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:a.id}})).status,'pending');assert.equal(await core.appointment.count({where:{id:a.id}}),0);}finally{docker('up','-d','--wait','rabbitmq');stopped=false;connection=await connect();channel=await connection.createConfirmChannel();channel.on('error',()=>{});}
  const consumer=await processHandle('services/notification/dist/worker.js',{BROKER_URL:broker,BROKER_PREFIX:prefix,DATABASE_URL:urls.notification});
  const events=await clinic.outboxEvent.findMany({where:{envelope:{path:['payload','relatedAppointmentId'],equals:a.id}}});assert.equal(events.length,2);
  // The retired read projection (see the cqrs-projection-archive tag): the write path leaves no read revision and no read-changed event.
  assert.equal(await clinic.clinicReadRevision.count({where:{aggregateId:a.id}}),0);
  assert.equal(await clinic.outboxEvent.count({where:{AND:[{envelope:{path:['eventType'],equals:'clinic.appointment-read-changed.v1'}},{envelope:{path:['aggregateId'],equals:a.id}}]}}),0);
  await until(async()=>{for(const e of events)if(!await notification.notification.findUnique({where:{id:e.envelope.payload.notificationId}}))return false;return true;},'notification catch-up');
  for(const e of events){await publishConfirmed(channel,routes.exchange,e.envelope.eventType,Buffer.from(JSON.stringify(e.envelope)),{messageId:e.id,contentType:'application/json'});}
  await waitForQueueIdle([routes.notification,routes.clinic]);for(const e of events)assert.equal(await notification.notification.count({where:{id:e.envelope.payload.notificationId}}),1);
  assert.ok(!JSON.stringify(events).includes('P3_PRIVATE_MARKER'));
  status(await request(`/api/appointments/${a.id}/reminder`,{method:'POST'}),403);
});
test('AQ-15 medical record audit: create/update/delete revisions in the same transaction, staff-only, kept after delete, immutable',async()=>{
  const created=status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{title:'Audit '+run})}),201).record;
  status(await request(`/api/medical-records/${created.id}`,{method:'PATCH',token:tokens.admin,body:{title:'Audit edited '+run,diagnosis:'Revised diagnosis',expectedRevision:0}}),200);
  // A rejected change (reassignment, 422) rolls back with no revision.
  status(await request(`/api/medical-records/${created.id}`,{method:'PATCH',token:tokens.admin,body:{petId:otherPet.id,expectedRevision:1}}),422);
  status(await request(`/api/medical-records/${created.id}/history`,{token:tokens.owner}),403);
  let history=status(await request(`/api/medical-records/${created.id}/history`,{token:tokens.staff}),200).items;
  assert.deepEqual(history.map(r=>r.action),['create','update']);
  assert.equal(history[0].before,null);assert.equal(history[0].after.title,'Audit '+run);assert.equal(history[0].actorId,doctor);assert.equal(history[0].actorRole,'doctor');
  assert.equal(history[1].before.title,'Audit '+run);assert.equal(history[1].after.title,'Audit edited '+run);assert.equal(history[1].after.diagnosis,'Revised diagnosis');assert.equal(history[1].actorId,admin);
  status(await request(`/api/medical-records/${created.id}?expectedRevision=1`,{method:'DELETE',token:tokens.admin}),204);
  history=status(await request(`/api/medical-records/${created.id}/history`,{token:tokens.admin}),200).items;
  assert.deepEqual(history.map(r=>r.action),['create','update','delete']);assert.deepEqual(history.map(r=>r.recordRevision),[0,1,1]);assert.equal(history[2].after,null);assert.equal(history[2].before.title,'Audit edited '+run);
  status(await request(`/api/medical-records/${randomUUID()}/history`,{token:tokens.admin}),404);
  for(const sql of ['UPDATE medical_record_revisions SET actor_id=\'forged\' WHERE record_id=$1','DELETE FROM medical_record_revisions WHERE record_id=$1'])
    await assert.rejects(clinic.$executeRawUnsafe(sql,created.id),/MEDICAL_RECORD_REVISION_IMMUTABLE/);
  assert.equal(await clinic.medicalRecordRevision.count({where:{recordId:created.id}}),3);
});
test('P11 the server decides who signs a medical record: the doctor in session, else the chosen or appointment doctor',async()=>{
  const second=randomUUID();await core.user.create({data:{id:second,role:'doctor',fullName:'P11 second doctor '+run,passwordHash:'fixture',passwordSalt:'fixture'}});
  const mine=status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{title:'P11 own '+run,doctorName:'Forged name'})}),201).record;
  assert.equal(mine.doctorId,doctor);assert.equal(mine.doctorName,`P3 doctor ${run}`);assert.equal(mine.revision,0);
  assert.match(status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{doctorId:second})}),403).error,/đứng tên bác sĩ khác/);
  assert.equal(status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{doctorId:doctor,title:'P11 own id '+run})}),201).record.doctorId,doctor);
  assert.equal(status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(null)}),422).code,'MEDICAL_RECORD_DOCTOR_REQUIRED');
  status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(null,{doctorId:staff})}),422);
  const chosen=status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(null,{doctorId:second,doctorName:'Forged name'})}),201).record;
  assert.equal(chosen.doctorId,second);assert.equal(chosen.doctorName,'P11 second doctor '+run);
  // An admin completing an appointment that names a doctor records it under that doctor; the audit keeps the admin as the one who entered it.
  let a=await create('13:00',{doctorId:second});a=await change(a,'confirmed');a=await change(a,'checked_in');
  const completed=status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:record(a)}),201).record;
  assert.equal(completed.doctorId,second);assert.equal(completed.doctorName,'P11 second doctor '+run);
  const entered=status(await request(`/api/medical-records/${completed.id}/history`,{token:tokens.admin}),200).items;assert.deepEqual([entered[0].actorId,entered[0].actorRole],[admin,'admin']);
  // Edits never reassign the author.
  const edited=status(await request(`/api/medical-records/${mine.id}`,{method:'PATCH',token:tokens.admin,body:{doctorName:'Forged name',title:'P11 edited '+run,expectedRevision:0}}),200).record;
  assert.deepEqual([edited.doctorId,edited.doctorName,edited.title],[doctor,`P3 doctor ${run}`,'P11 edited '+run]);
  const users=status(await request('/api/doctors',{token:tokens.admin}),200).items;assert.ok(users.some(d=>d.id===doctor)&&users.some(d=>d.id===second)&&!users.some(d=>d.id===staff||d.id===admin));
  status(await request('/api/doctors'),403);
});
test('P02 medical record optimistic lock: stale saves and deletes are refused with the stored record, never overwritten',async()=>{
  const created=status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{title:'P02 '+run,vaccineName:'Rabies',followUpDate:date,temperatureC:38.5,heartRateBpm:120})}),201).record;
  const path=`/api/medical-records/${created.id}`;
  for(const body of [{diagnosis:'No revision'},{diagnosis:'Negative',expectedRevision:-1},{diagnosis:'Fraction',expectedRevision:1.5}])status(await request(path,{method:'PATCH',token:tokens.admin,body}),422);
  status(await request(path,{method:'DELETE',token:tokens.admin}),422);
  // Two saves of the same revision one after the other: the second gets 409 and the first stays.
  const first=status(await request(path,{method:'PATCH',token:tokens.doctor,body:{diagnosis:'First save',expectedRevision:0}}),200).record;assert.equal(first.revision,1);
  const stale=status(await request(path,{method:'PATCH',token:tokens.admin,body:{diagnosis:'Second save',expectedRevision:0}}),409);
  assert.equal(stale.code,'MEDICAL_RECORD_STALE');assert.equal(stale.current.revision,1);assert.equal(stale.current.diagnosis,'First save');assert.equal(stale.current.internalNote,'P3_PRIVATE_MARKER');
  assert.equal((await clinic.medicalRecord.findUniqueOrThrow({where:{id:created.id}})).diagnosis,'First save');
  // Two concurrent saves on two Clinic processes queue on the record's row lock: exactly one wins.
  const held=await clinic.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM medical_records WHERE id=${created.id} FOR UPDATE`;const pending=bases.map((base,i)=>request(path,{base,method:'PATCH',token:tokens.admin,body:{treatment:'Race '+i,expectedRevision:1}}));await until(async()=>{const [state]=await clinic.$queryRaw`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM medical_records%FOR UPDATE%'`;return state.n>=2;},'two medical record row lock waiters',3000);return{pending};},{timeout:10000});
  const raced=await Promise.all(held.pending);assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);
  const winner=raced.find(r=>r.status===200).body.record;assert.equal(winner.revision,2);assert.equal(raced.find(r=>r.status===409).body.current.treatment,winner.treatment);
  // Cleared optional fields are cleared, not kept.
  const cleared=status(await request(path,{method:'PATCH',token:tokens.doctor,body:{vaccineName:null,followUpDate:null,weightKg:null,temperatureC:null,heartRateBpm:null,expectedRevision:2}}),200).record;
  assert.equal(cleared.vaccineName,null);for(const k of ['followUpDate','weightKg','temperatureC'])assert.ok(!(k in cleared),k);assert.equal(cleared.heartRateBpm,null);
  const row=await clinic.medicalRecord.findUniqueOrThrow({where:{id:created.id}});assert.deepEqual([row.vaccineName,row.followUpDate,row.weightKg,row.temperatureC,row.heartRateBpm,row.revision],[null,null,null,null,null,3]);
  assert.equal(status(await request(path+'?expectedRevision=2',{method:'DELETE',token:tokens.admin}),409).code,'MEDICAL_RECORD_STALE');assert.equal(await clinic.medicalRecord.count({where:{id:created.id}}),1);
  status(await request(path+'?expectedRevision=3',{method:'DELETE',token:tokens.admin}),204);
  const history=status(await request(path+'/history',{token:tokens.admin}),200).items;
  assert.deepEqual(history.map(r=>[r.action,r.recordRevision]),[['create',0],['update',1],['update',2],['update',3],['delete',3]]);
});
test('P10 scheduling: hours and slot grid, slot capacity under concurrency, pet and doctor overlap, cancel frees a place, availability',async()=>{
  // A date of this run only, so the capacity set below applies to fresh slots.
  const day=new Date(Date.UTC(2040,0,1)+(parseInt(run.slice(0,6),16)%7000)*86400000).toISOString().slice(0,10);
  const pets=[];for(let i=0;i<11;i++)pets.push(await core.pet.create({data:{ownerId:owner,name:`P10 pet ${i} ${run}`,species:'dog',allergies:[]}}));
  const book=(petId,time,extras={},options={})=>request('/api/appointments',{method:'POST',key:randomUUID(),body:{petId,type:'general_checkup',date:day,time,serviceName:'P10 '+run,...extras},...options});
  for(const [time,extras,code] of [['03:00',{},'APPOINTMENT_OUTSIDE_HOURS'],['17:30',{},'APPOINTMENT_OUTSIDE_HOURS'],['16:00',{type:'surgery'},'APPOINTMENT_OUTSIDE_HOURS'],['09:10',{},'APPOINTMENT_SLOT_MISALIGNED'],['11:00',{type:'spa_bath'},'APPOINTMENT_SLOT_MISALIGNED']])
    assert.equal(status(await book(pets[0].id,time,extras),422).code,code,time);
  // Ten bookings of one exam slot race on two Clinic processes for three places.
  await clinic.appointmentResourceGroup.update({where:{resourceGroup:'exam'},data:{capacity:3}});
  let raced;try{raced=await Promise.all(pets.slice(0,10).map((p,i)=>book(p.id,'09:00',{},{base:bases[i%2]})));}
  finally{await clinic.appointmentResourceGroup.update({where:{resourceGroup:'exam'},data:{capacity:1000}});}
  assert.deepEqual(raced.map(r=>r.status).sort(),[201,201,201,409,409,409,409,409,409,409]);
  assert.ok(raced.filter(r=>r.status===409).every(r=>r.body.code==='APPOINTMENT_SLOT_FULL'),JSON.stringify(raced.map(r=>r.body)));
  const nine=new Date(day+'T09:00:00+07:00'),slot=await clinic.appointmentSlotUsage.findUniqueOrThrow({where:{resourceGroup_slotStart:{resourceGroup:'exam',slotStart:nine}}});
  assert.deepEqual([slot.booked,slot.capacity],[3,3]);
  // A writer that bypasses the service is refused by the same database rule.
  await assert.rejects(clinic.appointment.create({data:{petId:pets[10].id,ownerId:owner,type:'vaccination',serviceName:'P10 bypass',clinicName:'Fixture',appointmentDate:new Date(day+'T00:00:00Z'),appointmentTime:'09:00'}}),/APPOINTMENT_SLOT_FULL/);
  // Availability reports the full slot; cancelling one booking frees its place for another pet.
  const slotsOf=async(query,token)=>status(await request('/api/appointments/availability?'+query,token?{token}:{}),200);
  let view=await slotsOf(`type=vaccination&date=${day}`);
  assert.deepEqual([view.slots[0].time,view.slots.at(-1).time,view.durationMinutes,view.resourceGroup],['08:00','17:00',30,'exam']);
  assert.deepEqual(view.slots.find(s=>s.time==='09:00'),{time:'09:00',remaining:0,past:false,available:false});
  const won=raced.flatMap((r,i)=>r.status===201?[r.body.appointment]:[]),refused=pets[raced.findIndex(r=>r.status===409)];
  status(await request(`/api/appointments/${won[0].id}/cancel`,{method:'PATCH',body:{expectedRevision:won[0].statusRevision}}),200);
  assert.equal((await slotsOf(`type=vaccination&date=${day}`)).slots.find(s=>s.time==='09:00').remaining,1);
  status(await book(refused.id,'09:00'),201);
  // Moving a booking into a full slot is refused and the booking keeps its time.
  const moved=status(await book(pets[10].id,'10:00'),201).appointment;
  assert.equal(status(await request(`/api/appointments/${moved.id}/reschedule`,{method:'PATCH',body:{date:day,time:'09:00',expectedRevision:moved.statusRevision}}),409).code,'APPOINTMENT_SLOT_FULL');
  assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:moved.id}})).appointmentTime,'10:00');
  // A pet is never in two visits at once; the visit right after is fine (half-open ranges).
  status(await book(pets[1].id,'10:30',{type:'spa_bath'}),201);
  assert.equal(status(await book(pets[1].id,'11:00'),409).code,'APPOINTMENT_PET_OVERLAP');
  status(await book(pets[1].id,'12:00'),201);
  // A doctor sees one pet at a time; only staff may ask for a doctor's busy slots.
  const vet=randomUUID();await core.user.create({data:{id:vet,role:'doctor',fullName:'P10 doctor '+run,passwordHash:'fixture',passwordSalt:'fixture'}});
  status(await book(pets[2].id,'14:00',{doctorId:vet}),201);
  assert.equal(status(await book(pets[3].id,'14:00',{doctorId:vet}),409).code,'APPOINTMENT_DOCTOR_BUSY');
  status(await book(pets[3].id,'14:30',{doctorId:vet}),201);
  status(await request(`/api/appointments/availability?type=general_checkup&date=${day}&doctorId=${vet}`),403);
  view=await slotsOf(`type=general_checkup&date=${day}&doctorId=${vet}`,tokens.staff);
  assert.deepEqual(view.slots.filter(s=>s.doctorBusy).map(s=>s.time),['14:00','14:30']);
  // Spa offers its five fixed slots of 90 minutes and shares places across the Spa types.
  view=await slotsOf(`type=spa_combo&date=${day}`);
  assert.deepEqual(view.slots.map(s=>s.time),['09:00','10:30','13:30','15:00','16:30']);
  assert.deepEqual([view.durationMinutes,view.resourceGroup,view.slots[1].remaining],[90,'spa',999]);
  status(await request('/api/appointments/availability?type=haircut&date='+day),422);
});
test('AQ-09 guarded tool moves legacy base64 images into the bucket; list payload carries claims, not content; orphans reported',{timeout:60000},async()=>{
  const tool=(...args)=>JSON.parse(execFileSync(process.execPath,['tools/phase2/migrate-medical-images.mjs',...args],{env:{...process.env,DATABASE_URL:urls.clinic},encoding:'utf8'}));
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(200000,7)]),dataUrl='data:image/png;base64,'+png.toString('base64');
  const ids=[];for(let i=0;i<3;i++)ids.push((await clinic.medicalImage.create({data:{petId:pet.id,ownerId:owner,title:'Legacy '+i+' '+run,imageUrl:dataUrl,mimeType:'image/png'}})).id);
  const dry=tool('--dry-run');assert.ok(dry.legacyRows>=3&&dry.legacyBytes>=3*dataUrl.length);assert.equal(await clinic.medicalImage.count({where:{id:{in:ids},imageUrl:null}}),0);
  const moved=tool('--run');assert.ok(moved.migrated>=3);assert.equal(moved.legacyRowsAfter,0);assert.deepEqual(moved.failed,[]);
  for(const row of await clinic.medicalImage.findMany({where:{id:{in:ids}}})){assert.equal(row.imageUrl,null);assert.equal(row.storageKey,'images/'+row.id);assert.equal(row.sizeBytes,png.length);}
  assert.equal(tool('--run').migrated,0);
  const page=status(await request(`/api/medical-records/images?petId=${pet.id}&pageSize=100`),200),mine=page.items.filter(i=>ids.includes(i.id));assert.equal(mine.length,3);
  for(const item of mine)assert.ok(Buffer.from(await (await fetch(item.url)).arrayBuffer()).equals(png));
  // Before/after: the old list returned every data URL inline; now one page is metadata plus valet keys.
  const before=3*dataUrl.length,after=Buffer.byteLength(JSON.stringify(mine));assert.ok(after*100<before,JSON.stringify({before,after}));
  process.stdout.write(JSON.stringify({aq09Payload:{images:3,legacyInlineBytes:before,claimBytes:after},tableBytesAfterMove:moved.tableBytes})+'\n');
  const stray='images/orphan-'+run;await blobs.put(stray,png,'image/png');
  assert.ok(tool('--orphans','--min-age-seconds','0').orphans.includes(stray));assert.ok(!tool('--orphans').orphans.includes(stray));
  assert.ok(tool('--orphans','--delete-orphans','--min-age-seconds','0').orphans.includes(stray));assert.ok(!tool('--orphans','--min-age-seconds','0').orphans.includes(stray));
  // Least privilege: the Clinic identity administers only its own bucket.
  await assert.rejects(blobStoreFromEnv({...blobTestEnv,BLOB_BUCKET:'p2-other-bucket'}).ensureBucket(),/403/);
  // Contract step: ready once no inline base64 is left; the SQL guard refuses otherwise (applied with ROLLBACK here).
  const contract=()=>execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml','exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','p2_clinic','-d','p2_clinic_test'],
    {input:`SET search_path=${new URL(urls.clinic).searchParams.get('schema')};\n`+readFileSync('deploy/phase2/medical-images-contract.sql','utf8').replace(/^COMMIT;$/m,'ROLLBACK;'),encoding:'utf8',stdio:['pipe','pipe','pipe']});
  assert.equal(tool('--check-contract').contractReady,true);assert.match(contract(),/ROLLBACK/);
  const legacy=await clinic.medicalImage.create({data:{petId:pet.id,ownerId:owner,title:'Legacy guard '+run,imageUrl:dataUrl,mimeType:'image/png'}});
  try{
    assert.throws(()=>tool('--check-contract'),error=>error.status===3&&JSON.parse(error.stdout).contractReady===false);
    assert.throws(contract,error=>/AQ09_LEGACY_IMAGES_REMAIN/.test(String(error.stderr)));
  }finally{await clinic.medicalImage.delete({where:{id:legacy.id}});}
  assert.equal(await clinic.medicalImage.count({where:{imageUrl:{not:null}}}),0);
  for(const id of ids)status(await request(`/api/medical-records/images/${id}`,{method:'DELETE',token:tokens.admin}),204);
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
test('AQ-05 deferred list authorization: a revoked token gets 401 from every list on an empty page, with or without petId; an owner cannot name another owner\'s pet (403)',async()=>{
  // The lists query first and ask Core once afterwards; the answer must still be Core's, never an empty page.
  const id=randomUUID();await core.user.create({data:{id,role:'staff',fullName:'AQ-05 deferred staff '+run,passwordHash:'fixture',passwordSalt:'fixture'}});
  const old=signToken(id,'staff'),iat=JSON.parse(Buffer.from(old.split('.')[1],'base64url').toString()).iat,empty='?q=aq05-nomatch-'+run;
  const lists=['/api/appointments','/api/medical-records','/api/medical-records/images'];
  for(const base of [coreUrl,bases[0],bases[1]])for(const path of lists){status(await request(path+empty,{base,token:old}),200);status(await request(path+'?petId='+pet.id,{base,token:old}),200);}
  await core.user.update({where:{id},data:{passwordChangedAt:new Date((iat+1)*1000)}});
  for(const base of [coreUrl,bases[0],bases[1]])for(const path of lists)for(const query of [empty,'?petId='+pet.id,'','?pageSize=0']){
    const r=await request(path+query,{base,token:old});assert.equal(r.status,401,base+path+query+' '+JSON.stringify(r.body));assert.match(r.body.error,/password was changed/i);assert.ok(!('items' in r.body)&&!('related' in r.body),'nothing from the query is returned');
  }
  // Owner A names owner B's pet: Core refuses (403), also when the page would have been empty.
  for(const base of [coreUrl,bases[0],bases[1]])for(const path of lists)for(const query of ['?petId='+otherPet.id,'?petId='+otherPet.id+'&pageSize=0']){
    const r=await request(path+query,{base,token:tokens.owner});assert.equal(r.status,403,base+path+query+' '+JSON.stringify(r.body));
  }
  for(const path of lists)status(await request(path+'?petId='+pet.id,{base:bases[0],token:tokens.other}),403);
});
test('P01: allowedActions in Clinic responses follow the role, and the server accepts each listed move',async()=>{
  const p=await core.pet.create({data:{ownerId:owner,name:'P01 pet '+run,species:'dog',allergies:[]}});
  const actions=a=>a.allowedActions.map(x=>x.kind+(x.to?':'+x.to:'')+(x.name?'@'+x.name:''));
  const read=async(a,token)=>status(await request('/api/appointments?petId='+p.id,{token}),200).items.find(i=>i.id===a.id);
  let a=await create('13:00',{petId:p.id});
  assert.deepEqual(actions(a),['cancel','reschedule'],'the owner who booked it');
  for(const role of ['staff','admin'])assert.deepEqual(actions(await read(a,tokens[role])),['transition:confirmed','transition:cancelled'],role);
  // Walk the visit with what the server lists; each listed move is accepted.
  for(const to of ['confirmed','checked_in']){assert.ok(actions(await read(a,tokens.staff)).includes('transition:'+to),to);a=await change(a,to,tokens.staff);}
  assert.deepEqual(actions(a),['transition:in_progress','undo:confirmed'],'staff may not write the record that completes the visit');
  assert.deepEqual(actions(await read(a,tokens.doctor)),['transition:in_progress','undo:confirmed','step:completed@medical-completed']);
  assert.deepEqual(actions(await read(a,tokens.owner)),[],'nothing for the owner once the pet is checked in');
  // The listed step is real: the doctor's record completes the visit.
  status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(a,{petId:p.id})}),201);
  a=await read(a,tokens.admin);assert.equal(a.status,'completed');assert.deepEqual(actions(a),['undo:in_progress']);
  assert.deepEqual(actions(await read(a,tokens.staff)),[],'reopening is for admins');
  // Guards over linked data are not in the list: the record now blocks the reopen with a 409 that says why.
  assert.match(status(await request(`/api/appointments/${a.id}/undo-status`,{method:'POST',token:tokens.admin,body:{expectedRevision:a.statusRevision,reason:'P01 fixture'}}),409).error,/bệnh án/);
});
test('CQRS cleanup migration: fence and source-acl triggers are gone, a frozen rebuild run blocks no write, open read-changed outbox rows are closed',async()=>{
  const hooks=await clinic.$queryRaw`SELECT c.relname||'.'||t.tgname AS hook FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=current_schema() AND NOT t.tgisinternal AND t.tgname IN ('read_rebuild_fence','appointment_query_source_membership','appointment_query_source_acl') ORDER BY 1`;
  assert.deepEqual(hooks,[]);
  const fence=await clinic.$queryRaw`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname=current_schema() AND p.proname='clinic_read_rebuild_fence'`;
  assert.equal(fence[0].n,0);
  // The 'projection' and 'directory' epoch triggers and their shared function are deliberately kept.
  const keptHooks=await clinic.$queryRaw`SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname=current_schema() AND NOT t.tgisinternal AND t.tgname IN ('appointment_query_projection','appointment_query_directory') ORDER BY 1`;
  assert.deepEqual(keptHooks.map(r=>r.name),['appointment_query_directory','appointment_query_projection']);
  const bump=await clinic.$queryRaw`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname=current_schema() AND p.proname='appointment_query_epoch_bump'`;
  assert.equal(bump[0].n,1);
  // The old fence refused every write to these tables while a frozen run owned by another backend existed.
  const epoch=async()=>(await clinic.appointmentQueryEpoch.findUniqueOrThrow({where:{scope:'source-acl'}})).revision;
  const before=await epoch(),runId=randomUUID(),consumerName='cqrs-cleanup-'+run;
  // A pet of this test only: the shared pet already holds 08:30 from the first test. Like the P01 test, the
  // pet and its appointment stay (run-unique data; nothing else in this file removes its own).
  const frozenPet=await core.pet.create({data:{ownerId:owner,name:'Frozen run pet '+run,species:'dog',allergies:[]}});
  await clinic.readRebuildRun.create({data:{id:runId,generation:'frozen-'+runId,ownerPid:1,frozen:true}});
  try{
    await create('08:30',{petId:frozenPet.id});
    status(await request('/api/medical-records',{method:'POST',token:tokens.doctor,key:randomUUID(),body:record(null,{title:'Frozen run '+run})}),201);
    await clinic.inboxEvent.create({data:{consumerName,eventId:randomUUID()}});
    assert.equal(await epoch(),before,'an appointment insert no longer bumps the source-acl epoch');
  }finally{
    await clinic.inboxEvent.deleteMany({where:{consumerName}});
    await clinic.readRebuildRun.delete({where:{id:runId}});
  }
  // Run the migration's own UPDATE on rows shaped like the leftovers. nextAttemptAt is in the future so no relay claims them.
  const sql=readFileSync('services/clinic/prisma/migrations/20261028000100_retire_cqrs_database_hooks/migration.sql','utf8');
  const close=/UPDATE "OutboxEvent"[^;]*;/.exec(sql)?.[0];
  assert.ok(close,'the migration closes retired outbox rows');
  const envelope=eventType=>({eventId:randomUUID(),eventType,schemaVersion:1,producer:'clinic',aggregateType:'appointment',aggregateId:run,aggregateVersion:1});
  const retired=randomUUID(),kept=randomUUID(),later=new Date(Date.now()+3600000);
  await clinic.outboxEvent.createMany({data:[{id:retired,envelope:envelope('clinic.appointment-read-changed.v1'),nextAttemptAt:later},{id:kept,envelope:envelope('notification.requested.v1'),nextAttemptAt:later}]});
  try{
    await clinic.$executeRawUnsafe(close);
    const rows=await clinic.outboxEvent.findMany({where:{id:{in:[retired,kept]}},select:{id:true,publishedAt:true}});
    assert.equal(rows.length,2,'the rows are kept');
    // publishedAt is TIMESTAMP(3) holding UTC, so Prisma's Date must be close to the clock whatever the session timezone.
    const closedAt=rows.find(r=>r.id===retired).publishedAt;
    assert.ok(closedAt&&Math.abs(Date.now()-closedAt.getTime())<10000,'the retired event type is marked published now, in UTC: '+closedAt?.toISOString());
    assert.equal(rows.find(r=>r.id===kept).publishedAt,null,'other event types stay open');
  }finally{await clinic.outboxEvent.deleteMany({where:{id:{in:[retired,kept]}}});}
});
