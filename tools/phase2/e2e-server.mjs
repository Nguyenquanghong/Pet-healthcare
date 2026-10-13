import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { assertTestProject, waitForQueueIdle } from './test-project.mjs';
import { PrismaClient as Core } from '@prisma/client';
import { PrismaClient as Clinic } from '../../services/clinic/src/generated/client/index.js';
import { PrismaClient as Notification } from '../../services/notification/src/generated/client/index.js';
import { hashPasswordAsync } from '../../backend/dist/src/lib/password.js';
import { OutboxRelay as CoreRelay } from '../../backend/dist/src/phase2/relay.js';
import { RuntimeOutboxStore } from '../../backend/dist/src/infrastructure/persistence/runtimeOutboxStore.js';
import { OutboxRelay as ClinicRelay } from '../../services/clinic/dist/relay.js';
import { AppointmentInvoiceBilling, ClinicBillingRemote } from '../../backend/dist/src/phase2/appointmentBilling.js';
import { topology, declareTopology } from '@nipopeto/messaging';
import amqp from 'amqplib';
import {drainHandles} from './drain-handles.mjs';

assert.equal(process.env.PHASE2_TEST_CONFIRM,'pet-phase2-p1-test');
assertTestProject();
const urls={core:'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test&connection_limit=4',clinic:'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof&connection_limit=4',notification:'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof&connection_limit=4'};
const db={core:new Core({datasourceUrl:urls.core}),clinic:new Clinic({datasourceUrl:urls.clinic}),notification:new Notification({datasourceUrl:urls.notification})};
for(const [name,client] of Object.entries(db)){
  const [identity]=await client.$queryRaw`SELECT current_database() AS db,current_user AS role`;
  assert.equal(identity.db,`p2_${name}_test`);assert.equal(identity.role,`p2_${name}`);
  const [marker]=await client.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.equal(marker.marker,`pet-phase2-p1-test:${name}:v1`);
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',name==='core'?'backend/prisma/schema.prisma':`services/${name}/prisma/schema.prisma`],{env:{...process.env,DATABASE_URL:urls[name]},stdio:'pipe'});
}
process.stdout.write('P6 E2E database identity and migrations checked\n');
const [{stamp:startedAt}]=await db.core.$queryRaw`SELECT transaction_timestamp() AS stamp`;
const run=randomUUID(),short=run.slice(0,8),password='P5Fixture-only-2026!',fixtureDir=resolve('test-results/phase2');
mkdirSync(fixtureDir,{recursive:true});
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),clinicToken='p5-clinic-'+randomUUID(),notificationToken='p5-notification-'+randomUUID();
const env={PHASE2_RUNTIME_REQUIRED:'1',JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_KEY_ID:'p6-e2e-1',JWT_ISSUER:'p5-core',JWT_AUDIENCE:'pet-healthcare',JWT_SECRET:'',CLINIC_SERVICE_TOKEN:'',NOTIFICATION_SERVICE_TOKEN:'',CLINIC_BILLING_TOKEN:clinicToken,CORE_NOTIFICATION_SEND_TOKEN:notificationToken,CORE_DIRECTORY_TOKEN:'p6-dir-'+randomUUID(),CORE_BILLING_EVIDENCE_TOKEN:'p6-evidence-'+randomUUID(),CLINIC_BOOTSTRAP_TOKEN:'p6-bootstrap-'+randomUUID(),REDIS_URL:'redis://127.0.0.1:6389',RATE_LIMIT_NAMESPACE:'p6-e2e-'+run,RATE_LIMIT_KEY_SECRET:'p6-limit-'+randomUUID(),OBSERVABILITY_TOKEN:'p6-metrics-'+randomUUID(),DB_POOL_LIMIT:'4',HASH_CONCURRENCY:'2',HASH_PENDING_LIMIT:'16',TRUST_PROXY_CIDRS:'',BROKER_URL:'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',BROKER_PREFIX:'p5.e2e.'+run};
Object.assign(process.env,env);
const hash=await hashPasswordAsync(password),users={};
for(const role of ['admin','owner','other','counter']){
  const id=randomUUID();users[role]=await db.core.user.create({data:{id,role:role==='admin'?'admin':'owner',fullName:`P5 ${role} ${short}`,phone:'090'+String(parseInt(short,16)).padStart(10,'0')+String(Object.keys(users).length),...(role==='admin'?{username:'p5_admin_'+short}:role==='counter'?{}:{email:`p5_${role}_${short}@example.test`}),...(role==='counter'?{passwordHash:'',passwordSalt:''}:hash)}});
}
const pets=[];
for(let n=0;n<21;n++)pets.push(await db.core.pet.create({data:{ownerId:users.owner.id,name:`P5 ${short} Pet ${String(n).padStart(2,'0')}`,species:n%2?'cat':'dog',breed:'Synthetic P5',allergies:[],qrToken:'p5_'+randomUUID().replaceAll('-',''),createdAt:new Date(startedAt.getTime()+n)}}));
const counterPet=await db.core.pet.create({data:{ownerId:users.counter.id,name:`P5 ${short} Counter pet`,species:'dog',allergies:[]}});
const otherPet=await db.core.pet.create({data:{ownerId:users.other.id,name:`P5 ${short} Other private pet`,species:'cat',allergies:[]}});
let loadDataset;
if(process.env.PHASE2_LOAD_RUN && process.env.PHASE2_LOAD_ACCOUNTS){
  const {createDataset}=await import('../../benchmarks/phase2/dataset.mjs');
  loadDataset=await createDataset(db,{run,hash,count:Number(process.env.PHASE2_LOAD_ACCOUNTS),anchor:startedAt});
}
const handles=[],ports={};
process.stdout.write('P6 E2E UUID fixtures created\n');
async function freePort(){const s=tcpServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(check,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('P5 readiness timeout: '+label);}
for(const name of ['core','clinic','notification'])ports[name]=await freePort();
const origins=Object.fromEntries(Object.entries(ports).map(([name,p])=>[name,'http://127.0.0.1:'+p]));
async function child(file,extra,ready){
  const c=spawn(process.execPath,[file],{env:{...process.env,...env,...extra},stdio:['ignore','pipe','pipe','ipc']});let logs='',ended=false,stopping=false;
  c.stdout.on('data',b=>logs+=b);c.stderr.on('data',b=>logs+=b);c.once('exit',(code,signal)=>{ended=true;writeFileSync(resolve(fixtureDir,'p6-child-'+c.pid+'.log'),logs);process.stdout.write(JSON.stringify({component:file,pid:c.pid,code,signal,expected:stopping,status:'child-exited'})+'\n');});
  const handle={stop:async()=>{if(!ended){stopping=true;c.send({type:'shutdown'});await until(()=>ended,'graceful child drain',15000);}assert.equal(c.exitCode,0,'Owned API/worker must drain successfully: '+file);},logs:()=>logs};handles.push(handle);
  await until(async()=>{if(ended)throw new Error('P5 owned process exited before readiness: '+file);return ready?ready():logs.includes('worker-ready');},file);return handle;
}
const apiEnv=name=>({DATABASE_URL:urls[name],PORT:String(ports[name]),CORE_SERVICE_URL:origins.core,CLINIC_SERVICE_URL:origins.clinic,NOTIFICATION_SERVICE_URL:origins.notification,...(name==='core'?{}:name==='clinic'?{JWT_PRIVATE_KEY:'',CORE_NOTIFICATION_SEND_TOKEN:''}:{JWT_PRIVATE_KEY:'',CORE_DIRECTORY_TOKEN:'',CORE_BILLING_EVIDENCE_TOKEN:'',CLINIC_BILLING_TOKEN:'',CLINIC_BOOTSTRAP_TOKEN:''}),CORS_ORIGIN:'http://127.0.0.1:5189',PAYMENTS_DEMO:'1',VNPAY_ENABLED:'false',VNPAY_TMN_CODE:'',VNPAY_HASH_SECRET:'',BANK_TRANSFER_ENABLED:'false'});
const startApi=name=>child(name==='core'?'backend/dist/src/index.js':`services/${name}/dist/index.js`,apiEnv(name),async()=>{try{return(await fetch(origins[name]+'/health/ready')).status===200;}catch{return false;}});
let coreApi=await startApi('core'),clinicApi=await startApi('clinic'),notificationApi=await startApi('notification');
process.stdout.write('P6 E2E strict APIs ready\n');
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',routes=topology('p5.e2e.'+run);
await until(async()=>{try{const c=await amqp.connect(broker);await c.close();return true;}catch{return false;}},'AMQP handshake');
await declareTopology(broker,routes);
const workerEnv={JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_ISSUER:'',JWT_AUDIENCE:'',JWT_KEY_ID:'',JWT_SECRET:'',CORE_DIRECTORY_TOKEN:'',CORE_BILLING_EVIDENCE_TOKEN:'',CLINIC_BILLING_TOKEN:'',CLINIC_BOOTSTRAP_TOKEN:'',CORE_NOTIFICATION_SEND_TOKEN:'',REDIS_URL:'',RATE_LIMIT_KEY_SECRET:'',OBSERVABILITY_TOKEN:''};
await child('services/clinic/dist/worker.js',{...workerEnv,DATABASE_URL:urls.clinic,CORE_DIRECTORY_TOKEN:env.CORE_DIRECTORY_TOKEN,CORE_SERVICE_URL:origins.core,BROKER_URL:broker,BROKER_PREFIX:'p5.e2e.'+run,OUTBOX_AGGREGATE_ID:run});
await child('services/notification/dist/worker.js',{...workerEnv,DATABASE_URL:urls.notification,BROKER_URL:broker,BROKER_PREFIX:'p5.e2e.'+run});
const fixture={run,password,admin:{id:users.admin.id,username:users.admin.username,fullName:users.admin.fullName},owner:{id:users.owner.id,email:users.owner.email,fullName:users.owner.fullName},other:{id:users.other.id,email:users.other.email,fullName:users.other.fullName},counter:{id:users.counter.id,fullName:users.counter.fullName},pets:pets.map(p=>({id:p.id,name:p.name,qrToken:p.qrToken})),counterPetId:counterPet.id,otherPetId:otherPet.id,origins};
if(loadDataset)Object.assign(fixture,{loadAccounts:loadDataset.accounts,dataset:loadDataset.description});
writeFileSync(resolve(fixtureDir,'p5-e2e-fixture.json'),JSON.stringify(fixture,null,2));
const controlPath=resolve(fixtureDir,'p5-e2e-controls.json');writeFileSync(controlPath,JSON.stringify({run}));
function control(){try{const c=JSON.parse(readFileSync(controlPath,'utf8'));return c.run===run?c:{};}catch{return{};}}
const billing=new AppointmentInvoiceBilling(db.core,new ClinicBillingRemote(new URL(origins.clinic),clinicToken));
let ending=false,loopBusy=false;
let coreRestart;
// Real production relay/SQL adapters, scoped to UUID aggregates created in this
// fixture. Never drain old failure evidence or all pending rows from earlier runs.
async function pump(){
  if(ending||loopBusy)return;loopBusy=true;
  try{
    const controls=control();
    // Explicit restart fault only. P6 retains Redis counters across process
    // lifetimes; normal browser cases run against one Core without quota reset.
    if(controls.restartCore&&controls.restartCore!==coreRestart){await coreApi.stop();coreApi=await startApi('core');coreRestart=controls.restartCore;}
    for(const [name,client]of [['core',db.core],['clinic',db.clinic]]){
      const rows=await client.outboxEvent.findMany({where:{publishedAt:null,createdAt:{gte:startedAt}},select:{envelope:true},take:100});
      for(const id of new Set(rows.map(r=>r.envelope.aggregateId))){
        const relay=name==='core'?new CoreRelay(new RuntimeOutboxStore(client),broker,id):new ClinicRelay(client,broker,id);
        if(controls.pauseDirectory&&rows.some(r=>r.envelope.aggregateId===id&&r.envelope.eventType.startsWith('directory.')))continue;
        await relay.once(run,routes);
      }
    }
    const ops=await db.core.appointmentBillingOperation.findMany({where:{createdAt:{gte:startedAt},finalizedAt:null},select:{id:true},take:16});
    for(const op of ops)await billing.reconcileOnce(run,1,op.id);
    if(controls.stopNotification&&notificationApi){await notificationApi.stop();notificationApi=null;}
    if(!controls.stopNotification&&!notificationApi)notificationApi=await startApi('notification');
    writeFileSync(resolve(fixtureDir,'p5-e2e-observed.json'),JSON.stringify({run,coreRestart,pauseDirectory:Boolean(controls.pauseDirectory),notificationStopped:notificationApi===null}));
  }catch{if(!ending)process.stdout.write('P5 fixture relay pending; retrying\n');}
  finally{loopBusy=false;}
}
const ticker=setInterval(()=>void pump(),250);await pump();
const root=resolve(process.env.P5_E2E_BASELINE==='1'?'test-results/phase2/p5-baseline-ui':'frontend/dist');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path.startsWith('/internal')||path.startsWith('/metrics')){res.writeHead(404);res.end();return;}
    if(path.startsWith('/api/')){
      const chunks=[];for await(const b of req)chunks.push(b);
      const headers={};for(const name of ['authorization','content-type','idempotency-key'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
      const r=await fetch(origins.core+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),redirect:'error',signal:AbortSignal.timeout(15000)});
      const body=Buffer.from(await r.arrayBuffer());for(const name of ['content-type','location','retry-after','cache-control'])if(r.headers.has(name))res.setHeader(name,r.headers.get(name));res.writeHead(r.status);res.end(body);return;
    }
    let file=resolve(root,'.'+decodeURIComponent(path));if(relative(root,file).startsWith('..')){res.writeHead(404);res.end();return;}
    try{if(!statSync(file).isFile())file=resolve(root,'index.html');}catch{file=resolve(root,'index.html');}
    res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});res.end(readFileSync(file));
  }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'P5 isolated proxy unavailable.'}));}
});
server.listen(5189,'127.0.0.1');await once(server,'listening');process.stdout.write('P5 isolated real-service UI ready\n');
export async function shutdown(){
  if(ending)return;clearInterval(ticker);
  writeFileSync(controlPath,JSON.stringify({run}));
  while(loopBusy)await new Promise(r=>setTimeout(r,100));
  await pump();ending=true;
  let failure;
  try{
    while(loopBusy)await new Promise(r=>setTimeout(r,100));
    await waitForQueueIdle([routes.clinic,routes.notification]);
  }catch(error){failure=error;process.stdout.write('P5 queues retained for failure diagnosis\n');}
  await new Promise(r=>server.close(r));
  try{await drainHandles(handles);}catch(error){failure??=error;}
  try{assert.ok(handles.every(h=>!/postgresql:\/\/|amqp:\/\/|BEGIN PRIVATE KEY|p2_\w+_fixture_only/.test(h.logs())),'P5 worker credential log leak');}catch(error){failure??=error;}
  let conn,channel;
  try{
    conn=await amqp.connect(broker);channel=await conn.createChannel();
    for(const name of [routes.clinic,routes.notification,routes.clinic+'.dlq',routes.notification+'.dlq']){const q=await channel.checkQueue(name);if(!failure&&q.messageCount===0&&q.consumerCount===0)await channel.deleteQueue(name);}
  }catch(error){failure??=error;}
  finally{
    await channel?.close().catch(error=>{failure??=error;});await conn?.close().catch(error=>{failure??=error;});
    const disconnected=await Promise.allSettled(Object.values(db).map(client=>client.$disconnect()));
    for(const result of disconnected)if(result.status==='rejected')failure??=result.reason;
  }
  if(failure)throw failure;
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void shutdown().then(()=>process.exit(0)).catch(()=>process.exit(1)));
