import test from 'node:test';
import {waitForQueueIdle} from './test-project.mjs';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer as tcpServer} from 'node:net';
import {request as httpRequest,createServer as httpServer} from 'node:http';
import {PrismaClient as CoreClient} from '@prisma/client';
import {PrismaClient as ClinicClient} from '../../services/clinic/src/generated/client/index.js';
import {PrismaClient as NotificationClient} from '../../services/notification/src/generated/client/index.js';
import {createCoreApp} from '../../backend/dist/src/phase2/coreApp.js';
import {AppointmentInvoiceBilling,ClinicBillingRemote} from '../../backend/dist/src/phase2/appointmentBilling.js';
import {AppointmentBilling} from '../../services/clinic/dist/runtimeBilling.js';
import {ClinicInbox} from '../../services/clinic/dist/inbox.js';
import {signToken} from '../../backend/dist/src/lib/token.js';
import {OutboxRelay} from '../../backend/dist/src/phase2/relay.js';
import {RuntimeOutboxStore} from '../../backend/dist/src/infrastructure/persistence/runtimeOutboxStore.js';
import {PrismaInvoiceRepository} from '../../backend/dist/src/infrastructure/persistence/invoiceRepository.js';
import {PrismaPaymentRepository} from '../../backend/dist/src/infrastructure/persistence/paymentRepository.js';
import {topology,declareTopology,publishConfirmed} from '@nipopeto/messaging';
import amqp from 'amqplib';

assert.equal(process.env.PHASE2_TEST_CONFIRM,'pet-phase2-p1-test');
const urls={core:'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test',clinic:'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof',notification:'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof'};
const core=new CoreClient({datasourceUrl:urls.core}),clinic=new ClinicClient({datasourceUrl:urls.clinic});
const notification=new NotificationClient({datasourceUrl:urls.notification});
const run=randomUUID(),owner=randomUUID(),other=randomUUID(),admin=randomUUID(),credential='p4-test-'+randomUUID();
const q5Races=process.env.CQRS_Q5_RACES==='1',racePairs=q5Races?JSON.parse(readFileSync('phase2-plan/cqrs/acceptance.json','utf8')).correctness.racePairsPerScenario:2;
assert.ok(Number.isSafeInteger(racePairs)&&racePairs>=2&&racePairs%2===0);
const raceEvidence={run,pairs:racePairs,prepareUndo:[],commitAbort:[]};
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',routes=topology('p4.billing.'+run),handles=[],coreBases=[],clinicBases=[];
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),tokens={},actor={sub:admin,role:'admin'};
let sourceServer,sourceUrl,sourcePort,pet,remote,billing,connection,channel,declared=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const close=s=>s?new Promise(r=>s.close(r)):Promise.resolve();
async function until(check,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await pause(20);}throw new Error('Timeout: '+label);}
async function port(){const s=tcpServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await close(s);return p;}
const env=()=>({JWT_PRIVATE_KEY:process.env.JWT_PRIVATE_KEY,JWT_PUBLIC_KEY:process.env.JWT_PUBLIC_KEY,JWT_ISSUER:'p4-core',JWT_AUDIENCE:'pet-healthcare',CLINIC_SERVICE_TOKEN:credential,JWT_SECRET:''});
async function child(file,extra,ready){const c=spawn(process.execPath,[file],{env:{...process.env,...env(),...extra},stdio:'pipe'});let logs='',ended=false;c.stdout.on('data',b=>logs+=b);c.stderr.on('data',b=>logs+=b);c.once('exit',()=>ended=true);const h={stop:async()=>{if(!ended){c.kill();await once(c,'exit');}},kill:async()=>{if(!ended){c.kill('SIGKILL');await once(c,'exit');}},logs:()=>logs};handles.push(h);await until(async()=>{if(ended)throw new Error('Built process exited before readiness');return ready?ready():logs.includes('worker-ready');},'built process');return h;}
async function startSource(){sourceServer=createCoreApp(core,{clinicUrl:clinicBases[0],clinicToken:credential}).listen(sourcePort,'127.0.0.1');await once(sourceServer,'listening');}
async function request(path,{base=coreBases[0],token=tokens.admin,method='GET',body,key,service}={}){const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...(service?{'X-Service-Token':service}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});return{status:r.status,headers:r.headers,body:r.status===204?null:await r.json()};}
const status=(r,n)=>{assert.equal(r.status,n,JSON.stringify(r.body));return r.body;};
const body=a=>({type:'appointment',relatedId:a.id,subtotal:123456,taxAmount:1234,discountAmount:234});
async function appointment(type='general_checkup'){
  const p=await core.pet.create({data:{ownerId:owner,name:'P4 '+randomUUID(),species:'dog',allergies:[]}});
  const a=await clinic.appointment.create({data:{petId:p.id,ownerId:owner,type,serviceName:'P4 service '+run,clinicName:'Fixture',appointmentDate:new Date('2026-10-12T00:00:00Z'),appointmentTime:'10:00',status:'completed',statusRevision:1,createdBy:'staff'}});
  await clinic.clinicReadRevision.create({data:{kind:'appointment',aggregateId:a.id,version:1}});
  await clinic.bookingStatusEvent.create({data:{kind:'appointment',bookingId:a.id,revision:1,action:'transition',fromStatus:'in_progress',toStatus:'completed',actorId:admin,actorName:'Fixture',actorRole:'admin'}});return a;
}
async function operation(a){const op=await billing.begin(actor,body(a),randomUUID());await core.appointmentBillingOperation.update({where:{id:op.id},data:{expectedRevision:a.statusRevision}});return billing.read(op.id);}
async function lockWait(db,table,count=1){await until(async()=>{const [r]=await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE ${'%'+table+'%'} AND pid<>pg_backend_pid()`;return r.n>=count;},'SQL lock waiter');}
async function undo(a){return request('/api/appointments/'+a.id+'/undo-status',{method:'POST',body:{expectedRevision:a.statusRevision,reason:'P4 fixture undo'}});}
const docker=(...args)=>execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml',...args],{stdio:'pipe',timeout:30000});

test.before(async()=>{
  for(const [service,db] of Object.entries({core,clinic,notification})){const [i]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;assert.equal(i.db,'p2_'+service+'_test');assert.equal(i.role,'p2_'+service);const [m]=await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;assert.equal(m.marker,'pet-phase2-p1-test:'+service+':v1');execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',service==='core'?'backend/prisma/schema.prisma':`services/${service}/prisma/schema.prisma`],{env:{...process.env,DATABASE_URL:urls[service]},stdio:'pipe'});}
  process.env.JWT_PRIVATE_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();process.env.JWT_PUBLIC_KEY=keys.publicKey.export({type:'spki',format:'pem'}).toString();process.env.JWT_ISSUER='p4-core';process.env.JWT_AUDIENCE='pet-healthcare';
  for(const [name,id,role] of [['owner',owner,'owner'],['other',other,'owner'],['admin',admin,'admin']]){await core.user.create({data:{id,role,fullName:'P4 '+name+' '+run,passwordHash:'fixture',passwordSalt:'fixture'}});tokens[name]=signToken(id,role);}
  sourcePort=await port();sourceUrl='http://127.0.0.1:'+sourcePort;
  for(let n=0;n<2;n++){const p=await port(),base='http://127.0.0.1:'+p;clinicBases.push(base);await child('services/clinic/dist/index.js',{...env(),JWT_PRIVATE_KEY:'',DATABASE_URL:urls.clinic,PORT:String(p),CORE_SERVICE_URL:sourceUrl},async()=>{try{return(await fetch(base+'/health/ready')).status===200;}catch{return false;}});}
  await startSource();
  for(let n=0;n<2;n++){const p=await port(),base='http://127.0.0.1:'+p;coreBases.push(base);await child('backend/dist/src/index.js',{DATABASE_URL:urls.core,PORT:String(p),CLINIC_SERVICE_URL:clinicBases[n],NOTIFICATION_SERVICE_URL:'',NOTIFICATION_SERVICE_TOKEN:''},async()=>{try{return(await fetch(base+'/api/health')).status<500;}catch{return false;}});}
  remote=new ClinicBillingRemote(new URL(clinicBases[0]),credential);billing=new AppointmentInvoiceBilling(core,remote);
  connection=await amqp.connect(broker);connection.on('error',()=>{});channel=await connection.createChannel();await declareTopology(broker,routes);declared=true;
});
test.after(async()=>{
  if(q5Races){const dir='test-results/phase2/cqrs/q5-billing-'+run;mkdirSync(dir,{recursive:true});writeFileSync(dir+'/races.json',JSON.stringify(raceEvidence,null,2));console.log(JSON.stringify({q5BillingRun:run,prepareUndoPairs:raceEvidence.prepareUndo.length,commitAbortPairs:raceEvidence.commitAbort.length,artifact:dir}));}
  for(const h of handles.reverse())await h.stop();await close(sourceServer);
  if(channel&&declared&&!q5Races)for(const name of [routes.notification,routes.clinic,routes.notification+'.dlq',routes.clinic+'.dlq']){try{const q=await channel.checkQueue(name);if(q.messageCount===0&&q.consumerCount===0)await channel.deleteQueue(name);}catch{break;}}
  try{await channel?.close();}catch{}try{await connection?.close();}catch{}
  await Promise.all([core.$disconnect(),clinic.$disconnect(),notification.$disconnect()]);
});

test('two built Core and Clinic processes: same-key charges commit one invoice/reservation; scope and key reuse',async()=>{
  const a=await appointment(),key=randomUUID(),responses=await Promise.all(Array.from({length:8},(_,n)=>request('/api/invoices',{base:coreBases[n%2],method:'POST',body:body(a),key})));
  for(const r of responses)status(r,201);assert.equal(new Set(responses.map(r=>r.body.invoice.id)).size,1);
  const invoice=responses[0].body.invoice;assert.equal(invoice.totalAmount,124456);assert.equal(invoice.appointmentId,a.id);assert.equal(invoice.sourceSnapshot.appointmentId,a.id);assert.equal(await core.appointment.count({where:{id:a.id}}),0);
  assert.equal(await clinic.appointmentReservation.count({where:{appointmentId:a.id}}),1);assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);
  status(await request('/api/invoices',{method:'POST',body:{...body(a),subtotal:200000},key}),409);
  const op=await core.appointmentBillingOperation.findFirstOrThrow({where:{idempotencyKey:key}});const result=status(await request('/api/operations/'+op.id),200);assert.equal(result.status,'succeeded');assert.equal(result.invoice.id,invoice.id);status(await request('/api/operations/'+op.id,{token:tokens.other}),404);
  status(await request('/api/invoices',{method:'POST',token:tokens.owner,body:body(a),key:randomUUID()}),403);status(await request('/api/operations/'+op.id,{token:null}),401);status(await request('/internal/billing-operations/'+op.id,{base:sourceUrl}),401);
  const internal=status(await request('/internal/billing-operations/'+op.id,{base:sourceUrl,service:credential,token:null}),200);assert.deepEqual(Object.keys(internal).sort(),['appointmentId','invoiceId','operationId','state']);
  await core.user.update({where:{id:admin},data:{role:'owner'}});try{status(await request('/api/operations/'+op.id,{token:signToken(admin,'owner')}),404);status(await request('/api/operations/'+op.id),403);}finally{await core.user.update({where:{id:admin},data:{role:'admin'}});}
  const contested=await appointment(),race=await Promise.all([0,1].map(n=>request('/api/invoices',{base:coreBases[n],method:'POST',body:body(contested),key:randomUUID()})));assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);assert.equal(await core.invoice.count({where:{appointmentId:contested.id}}),1);
  status(await request('/internal/billing-reservations/'+op.id+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:{}}),409);assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}})).state,'HELD');
});

test('baseline Spa checkout prices, existing invoice retry, source eligibility and integer VND limits',async()=>{
  const a=await appointment('spa_bath'),key=randomUUID();status(await request('/api/invoices/checkout',{method:'POST',token:tokens.owner,key,body:{type:'appointment',relatedId:a.id,taxAmount:1}}),422);
  const invoice=status(await request('/api/invoices/checkout',{method:'POST',token:tokens.owner,key,body:{type:'appointment',relatedId:a.id}}),200).invoice;
  const again=status(await request('/api/invoices/checkout',{base:coreBases[1],method:'POST',token:tokens.owner,key:randomUUID(),body:{type:'appointment',relatedId:a.id}}),200).invoice;assert.equal(again.id,invoice.id);assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);
  status(await request('/api/invoices/checkout',{method:'POST',token:tokens.other,key:randomUUID(),body:{type:'appointment',relatedId:a.id}}),404);
  const exam=await appointment();status(await request('/api/invoices/checkout',{method:'POST',token:tokens.owner,key:randomUUID(),body:{type:'appointment',relatedId:exam.id}}),409);
  const pending=await appointment();await clinic.appointment.update({where:{id:pending.id},data:{status:'confirmed'}});status(await request('/api/invoices',{method:'POST',key:randomUUID(),body:body(pending)}),409);assert.equal(await core.invoice.count({where:{appointmentId:pending.id}}),0);
  const large=await appointment();const max=status(await request('/api/invoices',{method:'POST',key:randomUUID(),body:{...body(large),subtotal:9999999999,taxAmount:0,discountAmount:0}}),201).invoice;assert.equal(max.totalAmount,9999999999);
  status(await request('/api/invoices',{method:'POST',key:randomUUID(),body:{...body(large),subtotal:1.5}}),422);
  status(await request('/api/invoices',{method:'POST',key:randomUUID(),body:{...body(large),expectedRevision:2147483648}}),422);
});

test('prepare versus real HTTP undo: SQL barriers prove both lock orders on actual appointments',async()=>{
 for(let pair=0;pair<racePairs/2;pair++){
  const reservation=new AppointmentBilling(clinic),a=await appointment(),op=await operation(a);let unlock,locked;const held=new Promise(r=>locked=r),gate=new Promise(r=>unlock=r);
  const preparing=reservation.prepare(op.id,a.id,a.statusRevision,actor,async()=>{locked();await gate;});await held;
  const undoing=undo(a);await lockWait(clinic,'appointments');unlock();await preparing;status(await undoing,409);assert.equal((await clinic.appointment.findUniqueOrThrow({where:{id:a.id}})).status,'completed');
  const b=await appointment(),otherOp=await operation(b);let release,entered;const barrier=new Promise(r=>release=r),acquired=new Promise(r=>entered=r);
  const holding=clinic.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${b.id} FOR UPDATE`;entered();await barrier;},{timeout:20000});await acquired;
  const wins=undo(b);await lockWait(clinic,'appointments',1);const loses=reservation.prepare(otherOp.id,b.id,b.statusRevision,actor).catch(e=>e);await lockWait(clinic,'appointments',2);release();await holding;status(await wins,200);assert.equal((await loses).status,409);assert.equal(await clinic.appointmentReservation.count({where:{appointmentId:b.id}}),0);
  raceEvidence.prepareUndo.push({pair:pair*2,winner:'prepare',status:'PASS'},{pair:pair*2+1,winner:'undo',status:'PASS'});
 }
});

test('commit versus abort under operation lock: both terminal winners, rollback, late commit and trusted release',async()=>{
 for(let pair=0;pair<racePairs/2;pair++){
  for(const action of ['commit','abort']){
    const a=await appointment(),op=await operation(a),s=await remote.prepare(op,actor);let release,entered;const gate=new Promise(r=>release=r),locked=new Promise(r=>entered=r);
    const first=billing.terminal(op.id,action,s,undefined,undefined,async()=>{entered();await gate;});await locked;
    const second=billing.terminal(op.id,action==='commit'?'abort':'commit',s);await lockWait(core,'AppointmentBillingOperation');release();const [one,two]=await Promise.all([first,second]);assert.equal(one.state,action==='commit'?'COMMITTED':'ABORTED');assert.equal(two.state,one.state);
    assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),action==='commit'?1:0);
    const finalize=action==='commit'?'commit':'release';status(await request('/internal/billing-reservations/'+op.id+'/'+finalize,{base:clinicBases[0],method:'POST',service:credential,token:null,body:{}}),200);
    const r=await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}});assert.equal(r.state,action==='commit'?'INVOICED':'RELEASED');
    assert.equal((await billing.terminal(op.id,'commit',s)).state,one.state);
    raceEvidence.commitAbort.push({pair:pair*2+(action==='commit'?0:1),winner:action,status:'PASS'});
  }
 }
  const a=await appointment(),op=await operation(a),s=await remote.prepare(op,actor);
  await assert.rejects(billing.terminal(op.id,'commit',s,undefined,()=>{throw new Error('test crash before transaction commit');}));assert.equal((await billing.read(op.id)).state,'PREPARING');assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),0);assert.equal(await core.outboxEvent.count({where:{envelope:{path:['aggregateId'],equals:op.id}}}),0);
  assert.equal((await billing.resume(op.id)).state,'COMMITTED');
});

test('late prepare after durable abort; missing/unavailable Core never releases HELD; inbox conflict rollback',async()=>{
  const a=await appointment(),op=await operation(a);await billing.terminal(op.id,'abort',undefined,{status:409,code:'Cancelled fixture'});
  // Abort event before prepare creates a durable tombstone without a reservation.
  const event=await core.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:op.id}}});const inbox=new ClinicInbox(clinic);await inbox.apply(JSON.stringify(event.envelope));await assert.rejects(remote.prepare(op,actor),e=>e.status===409);assert.equal(await clinic.appointmentReservation.count({where:{operationId:op.id}}),0);
  const late=await appointment(),aborted=await operation(late);await billing.terminal(aborted.id,'abort');await remote.prepare(aborted,actor);assert.equal((await billing.resume(aborted.id)).state,'ABORTED');status(await request('/internal/billing-reservations/'+aborted.id+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:{}}),200);assert.equal(await core.invoice.count({where:{appointmentId:late.id}}),0);
  const unknown=await appointment(),unknownId=randomUUID();await new AppointmentBilling(clinic).prepare(unknownId,unknown.id,1,actor);status(await request('/internal/billing-reservations/'+unknownId+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:{}}),503);assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:unknownId}})).state,'HELD');
  const b=await appointment(),pending=await operation(b);await remote.prepare(pending,actor);
  status(await request('/internal/billing-reservations/'+pending.id+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:{}}),409);
  status(await request('/internal/billing-reservations/'+pending.id+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:{state:'ABORTED'}}),422);
  status(await request('/internal/billing-reservations/'+pending.id+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:[]}),422);
  await close(sourceServer);sourceServer=undefined;try{status(await request('/internal/billing-reservations/'+pending.id+'/release',{base:clinicBases[0],method:'POST',service:credential,token:null,body:{}}),503);assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:pending.id}})).state,'HELD');}finally{await startSource();}
  await billing.terminal(pending.id,'commit',await remote.prepare(pending,actor));const issued=await core.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:pending.id}}});await inbox.apply(JSON.stringify(issued.envelope));assert.equal(await inbox.apply(JSON.stringify(issued.envelope)),false);
  const wrong={...issued.envelope,eventId:randomUUID(),eventType:'billing.operation-aborted.v1',payload:{operationId:pending.id,appointmentId:b.id}};await assert.rejects(inbox.apply(JSON.stringify(wrong)));assert.equal(await clinic.inboxEvent.count({where:{eventId:wrong.eventId}}),0);assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:pending.id}})).state,'INVOICED');
});

test('before-prepare and after-HELD crash states resume through two built leased reconcilers',async()=>{
  for(const held of [false,true]){
    const a=await appointment(),op=await operation(a);if(held)await remote.prepare(op,actor);
    if(held)await core.appointmentBillingOperation.update({where:{id:op.id},data:{leaseOwner:'dead-fixture-worker',leaseUntil:new Date(Date.now()-1)}});
    const workers=[];for(let n=0;n<2;n++)workers.push(await child('backend/dist/src/phase2/billingWorker.js',{DATABASE_URL:urls.core,CLINIC_SERVICE_URL:clinicBases[n],BILLING_OPERATION_ID:op.id}));
    await until(async()=> {const r=await billing.read(op.id);return r.finalizedAt!==null&&r.leaseOwner===null;},'reconciler terminal/finalized');for(const w of workers)await w.stop();
    const done=await billing.read(op.id);assert.equal(done.state,'COMMITTED');assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}})).state,'INVOICED');assert.equal(done.leaseOwner,null);assert.equal(done.leaseUntil,null);assert.ok(done.attempts>=1);
  }
});

test('actual built Core killed after HELD; lost prepare response yields 202/Location; restart workers finish same operation',async()=>{
  for(const kill of [false,true]){
    const a=await appointment(),key=randomUUID();let held,release;const reached=new Promise(r=>held=r),gate=new Promise(r=>release=r);
    const proxy=httpServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await fetch(clinicBases[0]+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),signal:AbortSignal.timeout(5000)});const bytes=Buffer.from(await r.arrayBuffer());if(req.method==='PUT'&&req.url.startsWith('/internal/billing-reservations/')){held();if(kill)await gate;res.destroy();return;}res.writeHead(r.status,{'Content-Type':'application/json'});res.end(bytes);}catch{res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');}}).listen(0,'127.0.0.1');await once(proxy,'listening');
    const p=await port(),base='http://127.0.0.1:'+p,h=await child('backend/dist/src/index.js',{DATABASE_URL:urls.core,PORT:String(p),CLINIC_SERVICE_URL:'http://127.0.0.1:'+proxy.address().port,NOTIFICATION_SERVICE_URL:'',NOTIFICATION_SERVICE_TOKEN:''},async()=>{try{return(await fetch(base+'/api/health')).status<500;}catch{return false;}});
    try{
      const sending=request('/api/invoices',{base,method:'POST',body:body(a),key}).catch(e=>e);await reached;
      // A crash, not a stop: on SIGTERM Core drains and would still answer the request (202).
      if(kill){await h.kill();release();assert.ok(await sending instanceof Error);}else{const response=await sending;status(response,202);assert.equal(response.body.status,'pending');assert.equal(response.headers.get('location'),'/api/operations/'+response.body.operationId);}
      const op=await core.appointmentBillingOperation.findFirstOrThrow({where:{idempotencyKey:key}});assert.equal(op.state,'PREPARING');assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}})).state,'HELD');assert.equal(status(await request('/api/operations/'+op.id),200).status,'pending');
      const worker=await child('backend/dist/src/phase2/billingWorker.js',{DATABASE_URL:urls.core,CLINIC_SERVICE_URL:clinicBases[1],BILLING_OPERATION_ID:op.id});await until(async()=> (await billing.read(op.id)).finalizedAt!==null,'crashed Core recovery');await worker.stop();
      const retry=status(await request('/api/invoices',{method:'POST',body:body(a),key}),201).invoice;assert.equal(retry.id,(await billing.read(op.id)).invoiceId);assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);
    }finally{release();await h.stop();await close(proxy);}
  }
});

test('actual outbox SQL constraint rollback keeps operation pending and one durable retry',async()=>{
  const a=await appointment(),op=await operation(a),name='p4_fault_'+randomUUID().replaceAll('-','');
  const notices=await core.outboxEvent.count({where:{envelope:{path:['payload','type'],equals:'invoice_requested'}}});
  await core.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" ADD CONSTRAINT "${name}" CHECK (envelope->>'aggregateId' <> '${op.id}')`);
  try{const result=await billing.resume(op.id);assert.equal(result.state,'PREPARING');assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),0);assert.equal(await core.outboxEvent.count({where:{envelope:{path:['aggregateId'],equals:op.id}}}),0);assert.equal(await core.outboxEvent.count({where:{envelope:{path:['payload','type'],equals:'invoice_requested'}}}),notices);assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}})).state,'HELD');}
  finally{await core.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" DROP CONSTRAINT "${name}"`);}
  const committed=await billing.resume(op.id);assert.equal(committed.state,'COMMITTED');assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);
});

test('public request deadline returns pending while SQL commit waits; same key resolves after lock release',async()=>{
  const a=await appointment(),key=randomUUID(),op=await billing.begin(actor,body(a),key);await core.appointmentBillingOperation.update({where:{id:op.id},data:{expectedRevision:1}});await remote.prepare(await billing.read(op.id),actor);
  let release,entered;const gate=new Promise(r=>release=r),locked=new Promise(r=>entered=r);
  const holding=core.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "AppointmentBillingOperation" WHERE id=${op.id} FOR UPDATE`;entered();await gate;},{timeout:15000});await locked;
  try{const sending=request('/api/invoices',{method:'POST',body:body(a),key});await lockWait(core,'AppointmentBillingOperation');const response=await sending;status(response,202);assert.equal(response.body.operationId,op.id);assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),0);}finally{release();await holding;}
  await until(async()=> (await billing.read(op.id)).state==='COMMITTED','in-flight commit after public deadline');status(await request('/api/invoices',{method:'POST',body:body(a),key}),201);assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);
});

test('historical invoice stays readable without clinical FK; transfer/IPN duplicates preserve financial totals',async()=>{
  const a=await appointment(),oldDate=new Date('2025-01-01T12:34:56.000Z');const old=await core.invoice.create({data:{id:randomUUID(),invoiceCode:'INV-LEGACY-'+randomUUID(),type:'appointment',ownerId:owner,petId:a.petId,appointmentId:randomUUID(),subtotal:100000,taxAmount:0,discountAmount:0,totalAmount:100000,paymentStatus:'paid',paymentMethod:'cash',issuedAt:oldDate,paidAt:oldDate,createdAt:oldDate,updatedAt:oldDate,items:{create:{description:'Historical fixture',quantity:1,unitPrice:100000,amount:100000}}}});
  const history=status(await request('/api/invoices?id='+old.id,{token:tokens.owner}),200).items;assert.equal(history.length,1);assert.equal(history[0].id,old.id);assert.equal(history[0].issuedAt,oldDate.toISOString());assert.equal(history[0].paidAt,oldDate.toISOString());assert.equal(history[0].totalAmount,100000);assert.equal(history[0].paymentStatus,'paid');assert.equal(history[0].sourceSnapshot,null);assert.equal(history[0].items[0].amount,100000);status(await request('/api/invoices?id='+old.id,{token:tokens.other}),200);
  const bank=await appointment(),bankInvoice=status(await request('/api/invoices',{method:'POST',body:body(bank),key:randomUUID()}),201).invoice;
  await new PrismaInvoiceRepository(core).chooseTransfer(bankInvoice.id,owner,{bankName:'Synthetic bank fixture',accountNumber:'fixture-account',accountHolder:'Synthetic fixture',isDemo:true});
  for(let n=0;n<2;n++)status(await request('/api/invoices/'+bankInvoice.id+'/transfer-report',{method:'POST',token:tokens.owner,body:{reference:'synthetic-transfer-reference'}}),200);
  assert.equal(await core.paymentEvent.count({where:{invoiceId:bankInvoice.id,action:'transfer_reported'}}),1);
  for(let n=0;n<2;n++)status(await request('/api/invoices/'+bankInvoice.id+'/pay',{method:'PATCH',body:{paymentMethod:'bank_transfer'}}),200);
  assert.equal(await core.paymentEvent.count({where:{invoiceId:bankInvoice.id,action:'payment_confirmed'}}),1);assert.equal(Number((await core.invoice.findUniqueOrThrow({where:{id:bankInvoice.id}})).totalAmount),124456);
  const online=await appointment(),onlineInvoice=status(await request('/api/invoices',{method:'POST',body:body(online),key:randomUUID()}),201).invoice;
  const payments=new PrismaPaymentRepository(core),attempt=await payments.prepare(onlineInvoice.id,owner),result={reference:attempt.id,amount:onlineInvoice.totalAmount,success:true,transactionNo:'synthetic-'+randomUUID(),responseCode:'00'};
  const replies=await Promise.all([payments.confirm(result),payments.confirm(result)]);assert.deepEqual(replies.map(r=>r.RspCode).sort(),['00','02']);const paid=await core.invoice.findUniqueOrThrow({where:{id:onlineInvoice.id}});assert.equal(paid.paymentStatus,'paid');assert.equal(paid.paymentMethod,'vnpay');assert.equal(Number(paid.totalAmount),onlineInvoice.totalAmount);assert.equal(await core.paymentAttempt.count({where:{invoiceId:onlineInvoice.id,status:'succeeded'}}),1);
});

test('real HTTP invoice response loss retries durable key; finalized invoice snapshot stays historical',async()=>{
  const a=await appointment(),key=randomUUID();await new Promise((resolve,reject)=>{const req=httpRequest(coreBases[0]+'/api/invoices',{method:'POST',headers:{Authorization:'Bearer '+tokens.admin,'Idempotency-Key':key,'Content-Type':'application/json'}},res=>{assert.equal(res.statusCode,201);res.destroy();resolve();});req.on('error',reject);req.end(JSON.stringify(body(a)));});
  const op=await core.appointmentBillingOperation.findFirstOrThrow({where:{idempotencyKey:key}});const retry=status(await request('/api/invoices',{base:coreBases[1],method:'POST',body:body(a),key}),201).invoice;assert.equal(retry.id,op.invoiceId);assert.equal(await core.invoice.count({where:{appointmentId:a.id}}),1);
  const original=retry.sourceSnapshot;await core.pet.update({where:{id:a.petId},data:{name:'Renamed P4 pet'}});await clinic.appointment.update({where:{id:a.id},data:{serviceName:'Historical fixture renamed'}});const polled=status(await request('/api/operations/'+op.id),200);assert.deepEqual(polled.invoice.sourceSnapshot,original);assert.equal(polled.invoice.totalAmount,124456);
  status(await request('/api/invoices/'+retry.id+'/onsite',{method:'PATCH',token:tokens.owner}),200);const paid=status(await request('/api/invoices/'+retry.id+'/pay',{method:'PATCH',body:{paymentMethod:'cash'}}),200).invoice;assert.equal(paid.paymentStatus,'paid');status(await request('/api/invoices/'+retry.id+'/pay',{method:'PATCH',body:{paymentMethod:'cash'}}),200);assert.equal(await core.paymentEvent.count({where:{invoiceId:retry.id,action:'payment_confirmed'}}),1);
});

test('broker down preserves invoice plus HELD; built consumer finalizes after recovery; unbilled counts before page',async()=>{
  await channel.close();channel=undefined;await connection.close();connection=undefined;docker('stop','rabbitmq');
  const a=await appointment();let op,invoice;try{const r=status(await request('/api/invoices',{method:'POST',body:body(a),key:randomUUID()}),201);invoice=r.invoice;op=await core.appointmentBillingOperation.findFirstOrThrow({where:{invoiceId:r.invoice.id}});assert.equal((await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}})).state,'HELD');const page=status(await request('/api/appointments?mode=unbilled&id='+a.id+'&pageSize=1',{token:tokens.owner}),200);assert.equal(page.pagination.total,0);assert.equal(page.items.length,0);assert.equal(page.counts.billingHeld,1);status(await undo(a),409);}finally{docker('start','rabbitmq');}
  await until(async()=>{try{connection=await amqp.connect(broker);connection.on('error',()=>{});return true;}catch{return false;}},'broker recovery');channel=await connection.createChannel();await declareTopology(broker,routes);
  const worker=await child('services/clinic/dist/worker.js',{JWT_PRIVATE_KEY:'',DATABASE_URL:urls.clinic,CORE_SERVICE_URL:sourceUrl,BROKER_URL:broker,BROKER_PREFIX:'p4.billing.'+run});
  const notificationWorker=await child('services/notification/dist/worker.js',{JWT_PRIVATE_KEY:'',DATABASE_URL:urls.notification,BROKER_URL:broker,BROKER_PREFIX:'p4.billing.'+run});
  const relay=new OutboxRelay(new RuntimeOutboxStore(core),broker,op.id);while(await relay.once(run,routes)){}
  await until(async()=> (await clinic.appointmentReservation.findUniqueOrThrow({where:{operationId:op.id}})).state==='INVOICED','billing event finalized');await waitForQueueIdle([routes.clinic]);await worker.stop();
  const notice=await core.outboxEvent.findFirstOrThrow({where:{AND:[{envelope:{path:['payload','type'],equals:'invoice_requested'}},{envelope:{path:['payload','message'],string_contains:invoice.invoiceCode}}]}});
  const notificationRelay=new OutboxRelay(new RuntimeOutboxStore(core),broker,notice.envelope.aggregateId);while(await notificationRelay.once(run,routes)){}
  const notificationId=notice.envelope.payload.notificationId;await until(async()=>Boolean(await notification.notification.findUnique({where:{id:notificationId}})),'invoice notification delivered');
  const confirm=await connection.createConfirmChannel();await publishConfirmed(confirm,routes.exchange,notice.envelope.eventType,Buffer.from(JSON.stringify(notice.envelope)),{messageId:notice.id,contentType:'application/json'});await confirm.close();await waitForQueueIdle([routes.notification]);assert.equal(await notification.inboxEvent.count({where:{eventId:notice.id}}),1);assert.equal(await notification.notification.count({where:{id:notificationId}}),1);assert.equal((await notification.notification.findUniqueOrThrow({where:{id:notificationId}})).recipientOwnerId,owner);await notificationWorker.stop();
  for(const h of handles)assert.ok(!/postgresql:\/\/|amqp:\/\/|p2_core_fixture_only|p2_clinic_fixture_only|BEGIN PRIVATE KEY/.test(h.logs()));
});
