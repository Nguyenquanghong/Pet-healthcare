import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {PrismaClient as CoreClient} from '@prisma/client';
import {PrismaClient as ClinicClient} from '../../services/clinic/src/generated/client/index.js';
import {PrismaClient as NotificationClient} from '../../services/notification/src/generated/client/index.js';
import {hashPassword,hashPasswordAsync} from '../../backend/dist/src/lib/password.js';
import {createClient} from 'redis';
import jwt from 'jsonwebtoken';
import {assertTestProject,waitForQueueIdle} from './test-project.mjs';
import {declareTopology,topology} from '@nipopeto/messaging';
import amqp from 'amqplib';
import {OutboxRelay as CoreRelay} from '../../backend/dist/src/phase2/relay.js';
import {RuntimeOutboxStore} from '../../backend/dist/src/infrastructure/persistence/runtimeOutboxStore.js';
import {OutboxRelay as ClinicRelay} from '../../services/clinic/dist/relay.js';
import {blobTestEnv} from './blob-test.mjs';
assert.equal(process.env.PHASE2_TEST_CONFIRM,'pet-phase2-p1-test');assertTestProject();
Object.assign(process.env,blobTestEnv);// spawned Clinic processes use the dedicated test bucket
const run=randomUUID(),short=run.slice(0,8),prefix='p6.resilience.'+run,routes=topology(prefix);
const urls={core:'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test&connection_limit=4',clinic:'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof&connection_limit=4',notification:'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof&connection_limit=4'};
const db={core:new CoreClient({datasourceUrl:urls.core}),clinic:new ClinicClient({datasourceUrl:urls.clinic}),notification:new NotificationClient({datasourceUrl:urls.notification})};
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',redisUrl='redis://127.0.0.1:6389',password='P6Fixture-only-2026!';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const secretNames=['CORE_DIRECTORY_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_NOTIFICATION_SEND_TOKEN'];
const secrets=Object.fromEntries(secretNames.map(name=>[name,'p6-'+randomUUID()]));
const common={PHASE2_RUNTIME_REQUIRED:'1',JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_PRIVATE_KEY:'',JWT_SECRET:'',JWT_ISSUER:'p6-core',JWT_AUDIENCE:'pet-healthcare',JWT_KEY_ID:'p6-test-1',REDIS_URL:redisUrl,RATE_LIMIT_NAMESPACE:'p6-'+run,RATE_LIMIT_KEY_SECRET:'p6-key-'+randomUUID(),OBSERVABILITY_TOKEN:'p6-metrics-'+randomUUID(),BROKER_URL:broker,BROKER_PREFIX:prefix,DB_POOL_LIMIT:'2',HASH_CONCURRENCY:'2',HASH_PENDING_LIMIT:'2',HASH_QUEUE_TIMEOUT_MS:'500',AUTH_LOGIN_ACCOUNT_LIMIT:'3',CORE_NOTIFICATION_SEND_TOKEN:'',CORE_DIRECTORY_TOKEN:'',CORE_BILLING_EVIDENCE_TOKEN:'',CLINIC_BILLING_TOKEN:'',CLINIC_BOOTSTRAP_TOKEN:'',CLINIC_SERVICE_TOKEN:'',NOTIFICATION_SERVICE_TOKEN:'',CORS_ORIGIN:'',TRUST_PROXY_HOPS:'',TRUST_PROXY_CIDRS:'',PAYMENTS_DEMO:'1',VNPAY_ENABLED:'false',VNPAY_TMN_CODE:'',VNPAY_HASH_SECRET:'',BANK_TRANSFER_ENABLED:'false'};
const handles=[],coreApis=[],clinicApis=[],tokens={},users=[];let pet,otherPet,proxy,privateProxy,nginx,startedAt,notificationApi,declared=false,redisStopped=false,brokerStopped=false,amqpConnection,amqpChannel;
const artifacts=resolve('test-results/phase2/p6-'+run);mkdirSync(resolve(artifacts,'logs'),{recursive:true});mkdirSync(resolve(artifacts,'temp'),{recursive:true});
const binary=process.env.P6_NGINX_BINARY??(process.platform==='win32'?resolve('test-results/phase2/tooling/nginx-1.30.5/nginx.exe'):'nginx');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(40);}throw new Error('Timeout: '+label);}
async function freePort(){const server=createServer().listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const docker=(...args)=>{assertTestProject();return execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml',...args],{stdio:'pipe',timeout:30000});};
async function processHandle(file,env,name,ready){
  const child=spawn(process.execPath,[file],{env:{...process.env,...common,...env},stdio:['ignore','pipe','pipe','ipc']});let output='',ended=false,exitCode;
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('exit',code=>{ended=true;exitCode=code;});
  const handle={child,name,base:'http://127.0.0.1:'+env.PORT,logs:()=>output,ended:()=>ended,kill:async()=>{if(!ended){child.kill('SIGKILL');await once(child,'exit');}},stop:async()=>{if(!ended){child.send({type:'shutdown'});await until(()=>ended,'graceful '+name,15000);}assert.equal(exitCode,0,'Graceful process exit: '+name);}};handles.push(handle);
  await until(async()=>{if(ended)throw new Error('Owned built process failed startup: '+name);return ready?ready(handle):output.includes('worker-ready');},name+' ready');return handle;
}
async function request(path,{base=proxy,token=tokens.owner,method='GET',body,key,headers={}}={}){
  const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return{status:r.status,body:r.status===204?null:(r.headers.get('content-type')??'').includes('application/json')?await r.json():await r.text(),headers:r.headers};
}
const expectStatus=(r,n,label='HTTP status')=>{assert.equal(r.status,n,label);return r.body;};
const login=(index=0,extra={})=>request('/api/auth/owner/login',{base:coreApis[index%2].base,method:'POST',token:null,body:{email:users[index].email,password},...extra});
const appointment=(time='10:00',extra={})=>({petId:pet.id,date:'2044-01-02',time,type:'spa_bath',serviceName:'P6 '+run,...extra});
async function create(time,extra={},options={}){return expectStatus(await request('/api/appointments',{method:'POST',body:appointment(time,extra),key:randomUUID(),...options}),201).appointment;}
const health=async h=>{try{return(await fetch(h.base+'/health/ready')).status===200;}catch{return false;}};
async function scopedCoreRelay(){
  const store=new RuntimeOutboxStore(db.core),ids=users.map(u=>u.id).concat(pet?.id??[],otherPet?.id??[]);
  const restricted={claim:(leaseOwner)=>db.core.$transaction(async tx=>{const rows=await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE "createdAt">=${startedAt} AND "publishedAt" IS NULL AND "nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND envelope->>'aggregateId'=ANY(${ids}::text[]) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;if(!rows[0])return null;return tx.outboxEvent.update({where:{id:rows[0].id},data:{leaseOwner,leaseUntil:new Date(Date.now()+30000),attempts:{increment:1}}});}),markPublished:(...args)=>store.markPublished(...args),retry:(...args)=>store.retry(...args)};
  const relay=new CoreRelay(restricted,broker,run);while(await relay.once(run,routes)){}
}
async function clinicRelay(appointmentId){const events=await db.clinic.outboxEvent.findMany({where:{envelope:{path:['payload','relatedAppointmentId'],equals:appointmentId}}});assert.ok(events.length,'Fixture appointment has outbox events');for(const event of events){const relay=new ClinicRelay(db.clinic,broker,event.envelope.aggregateId);while(await relay.once(run,routes)){};}}
test.before(async()=>{
  assert.ok(process.platform!=='win32'||existsSync(binary),'Install the documented pinned test-only nginx binary');
  for(const [service,client]of Object.entries(db)){
    const [identity]=await client.$queryRaw`SELECT current_database() AS db,current_user AS role`;assert.equal(identity.db,`p2_${service}_test`);assert.equal(identity.role,`p2_${service}`);
    const [marker]=await client.$queryRaw`SELECT marker FROM public.p2_test_marker`;assert.equal(marker.marker,`pet-phase2-p1-test:${service}:v1`);
    execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',service==='core'?'backend/prisma/schema.prisma':`services/${service}/prisma/schema.prisma`],{env:{...process.env,DATABASE_URL:urls[service]},stdio:'pipe'});
  }
  [{stamp:startedAt}]=await db.core.$queryRaw`SELECT transaction_timestamp() AS stamp`;
  const hash=await hashPasswordAsync(password),legacy=hashPassword(password);
  for(let i=0;i<64;i++)users.push(await db.core.user.create({data:{id:randomUUID(),role:'owner',email:`p6_${short}_${i}@example.test`,fullName:'P6 fixture '+i,...(i===0?legacy:hash)}}));
  const admin=await db.core.user.create({data:{id:randomUUID(),role:'admin',username:'p6_'+short,fullName:'P6 admin',...hash}});users.push(admin);
  pet=await db.core.pet.create({data:{ownerId:users[0].id,name:'P6 '+short,species:'dog',allergies:[]}});
  otherPet=await db.core.pet.create({data:{ownerId:users[1].id,name:'P6 other '+short,species:'cat',allergies:[]}});
  const ports=await Promise.all(Array.from({length:7},()=>freePort())),[c0,c1,l0,l1,n,edge,internal]=ports;
  proxy='http://127.0.0.1:'+edge;privateProxy='http://127.0.0.1:'+internal;
  const config=`worker_processes 1;\npid logs/nginx.pid;\nerror_log logs/error.log crit;\nevents {worker_connections 256;}\nhttp {\nlog_format evidence '{"status":"$status","upstream":"$upstream_status","instance":"$upstream_http_x_service_instance","requestId":"$http_x_request_id"}';\naccess_log logs/access.log evidence;\nupstream core {server 127.0.0.1:${c0};server 127.0.0.1:${c1};}\nupstream clinic {server 127.0.0.1:${l0} max_fails=1 fail_timeout=2s;server 127.0.0.1:${l1} max_fails=1 fail_timeout=2s;}\nproxy_connect_timeout 1s;proxy_read_timeout 12s;proxy_send_timeout 12s;proxy_http_version 1.1;proxy_set_header Connection "";proxy_set_header X-Request-Id $http_x_request_id;proxy_set_header X-Forwarded-For $remote_addr;proxy_next_upstream error timeout http_502 http_503 http_504;proxy_next_upstream_tries 2;\nserver {listen 127.0.0.1:${edge};default_type application/json;location ~ ^/(internal|metrics|health) {return 404 '{"error":"Private route."}';}location ~ ^/api/(appointments|medical-records|dashboard/clinic)(/|$) {proxy_pass http://clinic;}location /api/ {proxy_pass http://core;}location / {return 404 '{}';}}\nserver {listen 127.0.0.1:${internal};location = /metrics {return 404;}location / {proxy_pass http://clinic;}}\n}`;
  writeFileSync(resolve(artifacts,'nginx.conf'),config);
  execFileSync(binary,['-t','-p',artifacts.replaceAll('\\','/')+'/','-c','nginx.conf'],{stdio:'pipe'});
  nginx=spawn(binary,['-p',artifacts.replaceAll('\\','/')+'/','-c','nginx.conf','-g','daemon off;'],{stdio:'pipe'});nginx.stdout.resume();nginx.stderr.resume();
  await declareTopology(broker,routes);declared=true;
  for(let i=0;i<2;i++)coreApis.push(await processHandle('backend/dist/src/index.js',{...secrets,JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),DATABASE_URL:urls.core,PORT:String(i?c1:c0),SERVICE_INSTANCE_ID:'p6-core-'+i,CLINIC_SERVICE_URL:privateProxy,NOTIFICATION_SERVICE_URL:'http://127.0.0.1:'+n},'core-'+i,health));
  for(let i=0;i<2;i++)clinicApis.push(await processHandle('services/clinic/dist/index.js',{CORE_DIRECTORY_TOKEN:secrets.CORE_DIRECTORY_TOKEN,CORE_BILLING_EVIDENCE_TOKEN:secrets.CORE_BILLING_EVIDENCE_TOKEN,CLINIC_BILLING_TOKEN:secrets.CLINIC_BILLING_TOKEN,CLINIC_BOOTSTRAP_TOKEN:secrets.CLINIC_BOOTSTRAP_TOKEN,DATABASE_URL:urls.clinic,PORT:String(i?l1:l0),SERVICE_INSTANCE_ID:'p6-clinic-'+i,CORE_SERVICE_URL:coreApis[0].base},'clinic-'+i,health));
  notificationApi=await processHandle('services/notification/dist/index.js',{CORE_NOTIFICATION_SEND_TOKEN:secrets.CORE_NOTIFICATION_SEND_TOKEN,DATABASE_URL:urls.notification,PORT:String(n),CORE_SERVICE_URL:coreApis[0].base},'notification',health);
  tokens.owner=expectStatus(await login(0),200).token;
  tokens.admin=expectStatus(await request('/api/auth/admin/login',{method:'POST',token:null,body:{username:admin.username,password}}),200).token;
  await processHandle('services/clinic/dist/worker.js',{DATABASE_URL:urls.clinic,CORE_SERVICE_URL:coreApis[0].base,CORE_DIRECTORY_TOKEN:secrets.CORE_DIRECTORY_TOKEN,OUTBOX_AGGREGATE_ID:run},'clinic-worker');
  await processHandle('services/notification/dist/worker.js',{DATABASE_URL:urls.notification},'notification-worker');
  await scopedCoreRelay();
});
test.after(async()=>{
  let failure;
  try{
    // Restart only the dedicated stopped container, before full identity guard.
    if(redisStopped){execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml','up','-d','--wait','redis'],{stdio:'pipe'});redisStopped=false;}
    if(brokerStopped){execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml','up','-d','--wait','rabbitmq'],{stdio:'pipe'});brokerStopped=false;}
    if(declared){await waitForQueueIdle([routes.clinic,routes.notification]);}
  }catch(error){failure=error;}
  for(const handle of handles.reverse())try{if(!handle.ended())await handle.stop();}catch(error){failure??=error;await handle.kill().catch(()=>{});}
  if(nginx){try{execFileSync(binary,['-p',artifacts.replaceAll('\\','/')+'/','-c','nginx.conf','-s','quit'],{stdio:'pipe'});await until(()=>nginx.exitCode!==null,'nginx graceful exit',15000);}catch(error){failure??=error;nginx.kill();}}
  try{
    if(declared){amqpConnection=await amqp.connect(broker);amqpConnection.on('error',()=>{});amqpChannel=await amqpConnection.createChannel();const retained=[];for(const q of [routes.clinic,routes.clinic+'.dlq',routes.notification,routes.notification+'.dlq']){const state=await amqpChannel.checkQueue(q);if(state.messageCount)retained.push(q);else await amqpChannel.deleteQueue(q);}if(!retained.length)await amqpChannel.deleteExchange(routes.exchange);assert.deepEqual(retained,[],'Nonempty failed proof queues retained');}
    for(const h of handles){assert.ok(!/fixture_only|postgresql:\/\/|amqp:\/\/|BEGIN PRIVATE KEY|Bearer |P6Fixture-only/.test(h.logs()),'No credential in logs: '+h.name);for(const secret of Object.values(secrets))assert.ok(!h.logs().includes(secret));}
  }catch(error){failure??=error;}finally{await amqpConnection?.close().catch(()=>{});await Promise.all(Object.values(db).map(c=>c.$disconnect()));}
  if(failure)throw failure;
});
test('two Core replicas accept 60 legitimate clients sharing an IP; /me does not consume login quota; stored legacy credentials work',async()=>{
  for(let i=1;i<=60;i++)expectStatus(await login(i,{headers:{'X-Forwarded-For':'203.0.113.'+i}}),200,'same-IP valid login '+i);
  for(let i=0;i<60;i++)expectStatus(await request('/api/auth/me',{base:coreApis[i%2].base}),200);
  assert.equal(expectStatus(await request('/api/auth/me'),200).user.id,users[0].id);
});
test('account quota is one atomic Redis counter across Core replicas and cannot be bypassed by forged forwarded IP',async()=>{
  const index=61;for(let i=0;i<3;i++)expectStatus(await login(index,{base:coreApis[i%2].base}),200);
  const rejected=await login(index,{base:coreApis[1].base,headers:{'X-Forwarded-For':'198.51.100.33'}});expectStatus(rejected,429);assert.ok(Number(rejected.headers.get('retry-after'))>0);
  const client=createClient({url:redisUrl});client.on('error',()=>{});await client.connect();try{const found=await client.keys(common.RATE_LIMIT_NAMESPACE+':*');assert.ok(found.length>60);assert.ok(found.every(k=>!k.includes('@')&&!k.includes('127.0.0.1')));}finally{client.destroy();}
});
test('actual concurrent PBKDF2 admission returns explicit 503 instead of creating an unbounded hash queue',async()=>{
  const results=await Promise.all(Array.from({length:30},(_,i)=>login(i+1,{base:coreApis[i%2].base})));
  assert.ok(results.some(r=>r.status===503),'Must actually exercise hash overload, not only rate-limit rejection');assert.ok(results.every(r=>[200,503].includes(r.status)));
  for(const core of coreApis){const metrics=await request('/metrics',{base:core.base,headers:{'X-Service-Token':common.OBSERVABILITY_TOKEN}});expectStatus(metrics,200);assert.match(metrics.body,/pet_hash_peak_active\{[^}]+\} 2/);assert.match(metrics.body,/pet_hash_peak_queued\{[^}]+\} 2/);assert.match(metrics.body,/pet_hash_rejected\{[^}]+\} [1-9]/);}
});
test('JWT algorithm/issuer/audience/kid/role/expiry and forged actor are rejected at real API boundaries',async()=>{
  const sign=(body={role:'owner'},options={})=>jwt.sign(body,keys.privateKey,{algorithm:'RS256',issuer:common.JWT_ISSUER,audience:common.JWT_AUDIENCE,keyid:common.JWT_KEY_ID,subject:users[0].id,expiresIn:'1h',...options});
  for(const token of [sign(undefined,{issuer:'wrong'}),sign(undefined,{audience:'wrong'}),sign(undefined,{keyid:'wrong'}),sign({role:'invalid'}),sign(undefined,{expiresIn:-1}),jwt.sign({role:'owner'},'hmac-fixture-only',{algorithm:'HS256',subject:users[0].id,expiresIn:'1h'})])for(const base of [coreApis[0].base,clinicApis[0].base,notificationApi.base])expectStatus(await request(base===coreApis[0].base?'/api/auth/me':base===clinicApis[0].base?'/api/appointments':'/api/notifications',{base,token}),401);
  expectStatus(await request('/internal/directory/authorize',{base:coreApis[0].base,method:'POST',token:null,headers:{'X-Service-Token':secrets.CORE_DIRECTORY_TOKEN,'X-Actor-Id':users[0].id,'X-Actor-Role':'admin'},body:{petIds:[pet.id]}}),401);
});
test('service credentials have separate endpoint permissions; public nginx never forwards internal or metrics paths',async()=>{
  for(const prefix of ['appointments','notifications']){
    const status=await new Promise((resolve,reject)=>{const req=httpRequest(coreApis[0].base,{path:'/api/'+prefix+'/%2e%2e/%2e%2e/health/ready',headers:{Authorization:'Bearer '+tokens.owner}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(status,404,'Normalized proxy path must remain in the public domain');
  }
  for(const path of ['/internal/directory/export?kind=pet','/metrics','/health/ready'])expectStatus(await request(path,{headers:{'X-Service-Token':secrets.CORE_DIRECTORY_TOKEN}}),404);
  expectStatus(await request('/internal/directory/export?kind=pet',{base:coreApis[0].base,headers:{'X-Service-Token':secrets.CORE_NOTIFICATION_SEND_TOKEN}}),401);
  expectStatus(await request('/internal/billing-operations/'+randomUUID(),{base:coreApis[0].base,headers:{'X-Service-Token':secrets.CORE_DIRECTORY_TOKEN}}),401);
  expectStatus(await request('/internal/billing-sources/'+randomUUID(),{base:clinicApis[0].base,headers:{'X-Service-Token':secrets.CLINIC_BOOTSTRAP_TOKEN}}),401);
  expectStatus(await request('/internal/clinic/bootstrap?view=dashboard',{base:clinicApis[0].base,headers:{'X-Service-Token':secrets.CLINIC_BILLING_TOKEN}}),401);
  expectStatus(await request('/internal/clinic/bootstrap?view=dashboard',{base:clinicApis[0].base,headers:{'X-Service-Token':secrets.CLINIC_BOOTSTRAP_TOKEN}}),200);
  const bootstrap=expectStatus(await request('/api/bootstrap?view=dashboard',{base:coreApis[0].base}),200);assert.equal(bootstrap.regions.clinic.status,'available');
  expectStatus(await request('/internal/directory/export?kind=pet&id='+pet.id,{base:coreApis[0].base,headers:{'X-Service-Token':secrets.CORE_DIRECTORY_TOKEN}}),200);
  expectStatus(await request('/internal/billing-sources/'+randomUUID(),{base:clinicApis[0].base,token:tokens.admin,headers:{'X-Service-Token':secrets.CLINIC_BILLING_TOKEN}}),404);
  expectStatus(await request('/metrics',{base:clinicApis[0].base}),401);
});
test('real nginx distributes requests to both Clinic processes; durable same-key dedup and slot unique survive replicas',async()=>{
  const instances=new Set();for(let i=0;i<12;i++){const r=await request('/api/appointments?petId='+pet.id);expectStatus(r,200);instances.add(r.headers.get('x-service-instance'));}assert.deepEqual(instances,new Set(['p6-clinic-0','p6-clinic-1']));
  const key=randomUUID(),input=appointment('11:00'),ids=new Set(),writers=new Set();for(let i=0;i<4;i++){const r=await request('/api/appointments',{method:'POST',body:input,key});expectStatus(r,201);ids.add(r.body.appointment.id);writers.add(r.headers.get('x-service-instance'));}assert.equal(ids.size,1);assert.equal(writers.size,2);assert.equal(await db.clinic.appointment.count({where:{petId:pet.id,appointmentTime:'11:00'}}),1);
  const races=await Promise.all([request('/api/appointments',{method:'POST',body:appointment('11:30'),key:randomUUID()}),request('/api/appointments',{method:'POST',body:appointment('11:30',{type:'general_checkup'}),key:randomUUID()})]);assert.deepEqual(races.map(r=>r.status).sort(),[201,409]);assert.equal(await db.clinic.appointment.count({where:{petId:pet.id,appointmentTime:'11:30'}}),1);
});
test('medical images saved by one Clinic replica remain readable by the other replica from shared service storage',async()=>{
  const imageUrl='data:image/png;base64,iVBORw0KGgo=',image=expectStatus(await request('/api/medical-records/images',{base:clinicApis[0].base,token:tokens.admin,method:'POST',body:{petId:pet.id,title:'P6 shared image',imageUrl,mimeType:'image/png'}}),201).image;
  const read=expectStatus(await request('/api/medical-records/images?petId='+pet.id,{base:clinicApis[1].base}),200).items.find(i=>i.id===image.id);assert.ok(!('imageUrl'in read));
  // Valet key issued by replica 1 for an object written through replica 0; the bytes come straight from the bucket.
  const bytes=Buffer.from(imageUrl.split(',')[1],'base64'),fetched=await fetch(read.url);assert.equal(fetched.status,200);assert.ok(Buffer.from(await fetched.arrayBuffer()).equals(bytes));
  const connections={};for(const [service,client]of Object.entries(db)){const [row]=await client.$queryRaw`SELECT count(*) AS count FROM pg_stat_activity WHERE usename=current_user`;connections[service]=Number(row.count);}
  assert.ok(connections.clinic<=10);assert.ok(connections.core<=8);assert.ok(connections.notification<=8);
  for(const [name,api]of [['core-0',coreApis[0]],['core-1',coreApis[1]],['clinic-0',clinicApis[0]],['clinic-1',clinicApis[1]],['notification',notificationApi]]){
    const metrics=expectStatus(await request('/metrics',{base:api.base,headers:{'X-Service-Token':common.OBSERVABILITY_TOKEN}}),200);assert.ok(!metrics.includes('@example.test'));assert.ok(!metrics.includes(pet.id));writeFileSync(resolve(artifacts,name+'.prom'),metrics);
  }
  writeFileSync(resolve(artifacts,'resources.json'),JSON.stringify({connections,apiPoolLimit:2,workerPoolLimit:2,controlPoolLimit:4,hashConcurrency:2,hashPendingLimit:2,nginxVersion:process.platform==='win32'?'1.30.5':'system binary; capture nginx -v separately'}));
});
test('strict service startup rejects missing kid, aliased service credentials and signing keys leaked into a verifier process',async()=>{
  const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  for(const [file,extra]of [
    ['backend/dist/src/index.js',{...secrets,DATABASE_URL:urls.core,JWT_PRIVATE_KEY:privateKey,JWT_KEY_ID:''}],
    ['backend/dist/src/index.js',{...secrets,DATABASE_URL:urls.core,JWT_PRIVATE_KEY:privateKey,CORE_DIRECTORY_TOKEN:secrets.CLINIC_BILLING_TOKEN}],
    ['services/clinic/dist/index.js',{...secrets,DATABASE_URL:urls.clinic,JWT_PRIVATE_KEY:privateKey}],
    ['services/notification/dist/index.js',{CORE_NOTIFICATION_SEND_TOKEN:secrets.CORE_NOTIFICATION_SEND_TOKEN,DATABASE_URL:urls.notification,JWT_PRIVATE_KEY:privateKey}],
  ]){
    const child=spawn(process.execPath,[file],{env:{...process.env,...common,...extra,PORT:String(await freePort())},stdio:'pipe'});let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
    try{await until(()=>child.exitCode!==null,'rejected startup',10000);assert.equal(child.exitCode,1);assert.match(logs,/STARTUP_FAILED/);assert.ok(!logs.includes(privateKey));assert.ok(!logs.includes('postgresql://'));for(const secret of Object.values(secrets))assert.ok(!logs.includes(secret));}finally{if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
  }
});
test('a genuine SQL-blocked request returns a bounded HTTP deadline while late work keeps its actual result and process stays healthy',async()=>{
  const api=await processHandle('backend/dist/src/index.js',{...secrets,JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),DATABASE_URL:urls.core,PORT:String(await freePort()),CLINIC_SERVICE_URL:privateProxy,NOTIFICATION_SERVICE_URL:notificationApi.base,HTTP_DEADLINE_MS:'500',SERVICE_INSTANCE_ID:'p6-deadline'},'deadline-core',health);
  let release,locked;const hold=new Promise(r=>release=r),acquired=new Promise(r=>locked=r);
  const barrier=db.core.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM users WHERE id=${users[1].id} FOR UPDATE`;locked();await hold;},{timeout:10000});await acquired;
  const token=jwt.sign({role:'owner'},keys.privateKey,{algorithm:'RS256',issuer:common.JWT_ISSUER,audience:common.JWT_AUDIENCE,keyid:common.JWT_KEY_ID,subject:users[1].id,expiresIn:'1h'});
  try{
    const pending=request('/api/auth/me',{base:api.base,token,method:'PATCH',body:{fullName:'P6 late '+short,email:users[1].email}});
    await until(async()=>{const [row]=await db.core.$queryRaw`SELECT count(*) AS count FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%UPDATE%'`;return Number(row.count)>0;},'deadline SQL waiter',3000);
    const response=await pending;expectStatus(response,503);assert.ok(response.headers.has('retry-after'));assert.match(response.body.error,/uncertain write/);
  }finally{release();await barrier;}
  await until(async()=> (await db.core.user.findUniqueOrThrow({where:{id:users[1].id}})).fullName==='P6 late '+short,'late SQL result');
  expectStatus(await request('/api/auth/me',{base:api.base}),200);assert.ok(!api.logs().includes('ERR_HTTP_HEADERS_SENT'));await api.stop();
});
test('actual persisted outbox backlog degrades readiness and rejects writes at the configured hard threshold while reads remain available',async()=>{
  assert.ok(await db.core.outboxEvent.count({where:{publishedAt:null}})>=2);
  const api=await processHandle('backend/dist/src/index.js',{...secrets,JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),DATABASE_URL:urls.core,PORT:String(await freePort()),CLINIC_SERVICE_URL:privateProxy,NOTIFICATION_SERVICE_URL:notificationApi.base,OUTBOX_SOFT_LIMIT:'1',OUTBOX_HARD_LIMIT:'2',SERVICE_INSTANCE_ID:'p6-backlog'},'backlog-core',health);
  const state=expectStatus(await request('/health/ready',{base:api.base}),200);assert.equal(state.status,'degraded');assert.ok(state.outboxPending>=2);
  expectStatus(await request('/api/auth/me',{base:api.base}),200);
  const denied=await request('/api/auth/me',{base:api.base,method:'PATCH',body:{fullName:'Should not persist',email:users[0].email}});expectStatus(denied,503);assert.match(denied.body.error,/backlog/);assert.equal(denied.headers.get('retry-after'),'5');await api.stop();
});
test('Redis down: auth writes fail closed, JWT reads stay available under explicit bounded degraded policy, then shared authority recovers',async()=>{
  docker('stop','redis');redisStopped=true;
  expectStatus(await login(63),503);
  const read=await request('/api/auth/me');expectStatus(read,200);assert.equal(read.headers.get('x-service-degraded'),'redis');
  const clinic=await request('/api/appointments?petId='+pet.id);expectStatus(clinic,200);assert.equal(clinic.headers.get('x-service-degraded'),'redis');
  expectStatus(await request('/api/appointments',{method:'POST',body:appointment('12:00'),key:randomUUID()}),503);
  const policy=await request('/health/ready',{base:clinicApis[0].base});expectStatus(policy,200);assert.equal(policy.body.status,'degraded');
  execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml','up','-d','--wait','redis'],{stdio:'pipe'});redisStopped=false;
  await until(async()=>{const r=await request('/api/auth/me');return r.status===200&&!r.headers.has('x-service-degraded');},'Redis authority restored');
});
test('broker down leaves API ready/degraded, Clinic write and outbox commit; recovery delivers one notice with original event',async()=>{
  docker('stop','rabbitmq');brokerStopped=true;
  const correlation=randomUUID(),a=await create('12:30',{}, {headers:{'X-Request-Id':correlation}}),original=await db.clinic.outboxEvent.findFirstOrThrow({where:{envelope:{path:['payload','relatedAppointmentId'],equals:a.id}}});assert.equal(original.envelope.correlationId,correlation);
  await sleep(3100);const state=await request('/health/ready',{base:clinicApis[0].base});expectStatus(state,200);assert.equal(state.body.broker,false);assert.equal(state.body.status,'degraded');
  await assert.rejects(clinicRelay(a.id));
  assert.ok(await db.clinic.outboxEvent.findFirst({where:{envelope:{path:['payload','relatedAppointmentId'],equals:a.id},publishedAt:null}}));
  execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml','up','-d','--wait','rabbitmq'],{stdio:'pipe'});brokerStopped=false;
  await until(async()=>{await clinicRelay(a.id);return await db.notification.notification.count({where:{relatedAppointmentId:a.id}})===1;},'notice catch-up');
  await clinicRelay(a.id);assert.equal(await db.notification.notification.count({where:{relatedAppointmentId:a.id}}),1);
  const worker=handles.find(h=>h.name==='notification-worker');await until(()=>worker.logs().includes(correlation)&&worker.logs().includes(original.envelope.eventId),'committed event correlation in worker log');
});
test('a Clinic process killed between live requests is removed by nginx; surviving replica keeps durable state',async()=>{
  await clinicApis[0].kill();const outcomes=[];for(let i=0;i<15;i++){const r=await request('/api/appointments?petId='+pet.id);outcomes.push(r.status);if(r.status===200)assert.equal(r.headers.get('x-service-instance'),'p6-clinic-1');}
  assert.ok(outcomes.filter(s=>s===200).length>=14);assert.ok(outcomes.every(s=>[200,502,503,504].includes(s)));writeFileSync(resolve(artifacts,'replica-outage.json'),JSON.stringify({statuses:outcomes}));
  const key=randomUUID(),input=appointment('13:00'),a=expectStatus(await request('/api/appointments',{method:'POST',body:input,key}),201).appointment;
  const replay=expectStatus(await request('/api/appointments',{method:'POST',body:input,key}),201).appointment;assert.equal(replay.id,a.id);assert.equal(await db.clinic.appointment.count({where:{petId:pet.id,appointmentTime:'13:00'}}),1);
});
test('registration, password change and counter activation retain the same owner, pets, clinical and invoice history',async()=>{
  const email='p6_registered_'+short+'@example.test';
  expectStatus(await request('/api/auth/owner/register',{method:'POST',token:null,body:{fullName:'P6 registered',email,password:'weak',confirmPassword:'weak'}}),422);
  const registered=expectStatus(await request('/api/auth/owner/register',{method:'POST',token:null,body:{fullName:'P6 registered',email,password,confirmPassword:password}}),201);assert.ok(registered.token);assert.equal(registered.user.email,email);
  expectStatus(await request('/api/auth/owner/register',{method:'POST',token:null,body:{fullName:'P6 registered',email,password,confirmPassword:password}}),409);
  const nextPassword='P6Changed-only-2026!';
  expectStatus(await request('/api/auth/me/password',{method:'POST',body:{currentPassword:password,newPassword:nextPassword,confirmPassword:nextPassword}}),204);
  expectStatus(await login(0),401);const changed=expectStatus(await login(0,{body:{email:users[0].email,password:nextPassword}}),200);assert.equal(changed.user.id,users[0].id);
  // AQ-05: the session issued before the change is revoked; later tests use the new login.
  expectStatus(await request('/api/pets'),401);tokens.owner=changed.token;expectStatus(await request('/api/pets'),200);
  const counter=await db.core.user.create({data:{id:randomUUID(),role:'owner',fullName:'P6 counter',passwordHash:'',passwordSalt:''}}),counterPet=await db.core.pet.create({data:{ownerId:counter.id,name:'P6 counter pet',species:'cat',allergies:[]}});
  let a=await create('14:00',{petId:counterPet.id,type:'general_checkup'},{token:tokens.admin});
  for(const state of ['confirmed','checked_in'])a=expectStatus(await request('/api/appointments/'+a.id+'/status',{method:'PATCH',token:tokens.admin,body:{status:state,expectedRevision:a.statusRevision}}),200).appointment;
  const record=expectStatus(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:{petId:counterPet.id,appointmentId:a.id,title:'P6 history',doctorName:'P6 synthetic doctor',visitDate:'2044-01-02',diagnosis:'Fixture diagnosis',treatment:'Fixture treatment'}}),201).record;
  const issued=await request('/api/invoices',{method:'POST',token:tokens.admin,key:randomUUID(),body:{type:'appointment',relatedId:a.id,subtotal:95000,taxAmount:0,discountAmount:0}});assert.ok([201,202].includes(issued.status));
  const operation=await db.core.appointmentBillingOperation.findFirstOrThrow({where:{appointmentId:a.id,actorId:users.at(-1).id}});
  await processHandle('backend/dist/src/phase2/billingWorker.js',{DATABASE_URL:urls.core,JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),CLINIC_SERVICE_URL:privateProxy,CLINIC_BILLING_TOKEN:secrets.CLINIC_BILLING_TOKEN,BILLING_OPERATION_ID:operation.id},'billing-worker');
  if(issued.status===202)await until(async()=>{const op=await request('/api/operations/'+operation.id,{token:tokens.admin});return op.body.status==='succeeded';},'counter invoice');
  const invoice=await db.core.invoice.findUnique({where:{appointmentId:a.id}});assert.ok(invoice);
  await until(async()=> (await db.clinic.appointmentReservation.findFirst({where:{appointmentId:a.id,state:'INVOICED'}}))?.state==='INVOICED','scoped terminal evidence finalizes reservation');
  const invitation=expectStatus(await request('/api/owners/'+counter.id+'/activation',{method:'POST',token:tokens.admin,body:{email:'p6_counter_'+short+'@example.test',customerVerified:true}}),201).activation;
  expectStatus(await request('/api/auth/owner/activation/inspect',{method:'POST',token:null,body:{token:invitation.token}}),200);
  expectStatus(await request('/api/auth/owner/activation',{method:'POST',token:null,body:{token:invitation.token,password,confirmPassword:password}}),200);
  expectStatus(await request('/api/auth/owner/activation',{method:'POST',token:null,body:{token:invitation.token,password,confirmPassword:password}}),422);
  const activated=expectStatus(await request('/api/auth/owner/login',{method:'POST',token:null,body:{email:invitation.email,password}}),200);assert.equal(activated.user.id,counter.id);
  assert.equal((await db.core.pet.findUniqueOrThrow({where:{id:counterPet.id}})).ownerId,counter.id);assert.equal((await db.clinic.appointment.findUniqueOrThrow({where:{id:a.id}})).ownerId,counter.id);
  assert.equal((await db.clinic.medicalRecord.findUniqueOrThrow({where:{id:record.id}})).petId,counterPet.id);assert.equal((await db.core.invoice.findUniqueOrThrow({where:{id:invoice.id}})).ownerId,counter.id);
});
test('activation revoke and expiry remain effective without consuming or replacing the owner history',async()=>{
  const counter=await db.core.user.create({data:{id:randomUUID(),role:'owner',fullName:'P6 expiry counter',passwordHash:'',passwordSalt:''}});
  const issue=async()=>expectStatus(await request('/api/owners/'+counter.id+'/activation',{method:'POST',token:tokens.admin,body:{email:'p6_expiry_'+short+'@example.test',customerVerified:true}}),201).activation;
  const first=await issue(),second=await issue();expectStatus(await request('/api/auth/owner/activation/inspect',{method:'POST',token:null,body:{token:first.token}}),422);
  await db.core.ownerActivation.updateMany({where:{ownerId:counter.id,revokedAt:null},data:{expiresAt:new Date(Date.now()-60000)}});
  expectStatus(await request('/api/auth/owner/activation/inspect',{method:'POST',token:null,body:{token:second.token}}),422);assert.equal((await db.core.user.findUniqueOrThrow({where:{id:counter.id}})).passwordHash,'');
});
test('private metrics show actual HTTP, DB/pool/hash/outbox/queue/billing state without high-cardinality or secret labels',async()=>{
  const correlation=randomUUID(),response=await request('/api/appointments?petId='+pet.id,{headers:{'X-Request-Id':correlation}});expectStatus(response,200);assert.equal(response.headers.get('x-request-id'),correlation);
  const metrics=expectStatus(await request('/metrics',{base:clinicApis[1].base,headers:{'X-Service-Token':common.OBSERVABILITY_TOKEN}}),200);
  for(const metric of ['http_duration_seconds_bucket','outbox_pending','outbox_oldest_seconds','db_lock_waits','queue_ready','dlq_ready','billing_pending','rss_bytes','cpu_seconds_total'])assert.ok(metrics.includes('pet_'+metric));assert.ok(!metrics.includes(pet.id));assert.ok(!metrics.includes(users[0].email));
  assert.ok(clinicApis[1].logs().includes(correlation));assert.ok(coreApis[0].logs().includes(correlation),'Directory call propagates correlation');
  const [connections]=await db.clinic.$queryRaw`SELECT count(*) AS count FROM pg_stat_activity WHERE usename=current_user`;
  assert.ok(Number(connections.count)<=10,'Two API pools of 2, worker pool of 2, fixture/control pool <=4');
});
test('Notification worker drains a genuine SQL-blocked inbox effect without ACK before commit',async()=>{
  const worker=handles.find(h=>h.name==='notification-worker');let release,locked;const hold=new Promise(r=>release=r),acquired=new Promise(r=>locked=r);
  const barrier=db.notification.$transaction(async tx=>{await tx.$executeRaw`LOCK TABLE "InboxEvent" IN SHARE MODE`;locked();await hold;},{timeout:12000});await acquired;let appointmentId,draining;
  try{
    appointmentId=(await create('14:30')).id;await clinicRelay(appointmentId);
    await until(async()=>{const [row]=await db.notification.$queryRaw`SELECT count(*) AS count FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%InboxEvent%'`;return Number(row.count)>0;},'consumer SQL blocked',3000);
    assert.equal(await db.notification.notification.count({where:{relatedAppointmentId:appointmentId}}),0);
    const queues=docker('exec','-T','rabbitmq','rabbitmqctl','list_queues','name','messages_unacknowledged','--quiet').toString();assert.match(queues,new RegExp(routes.notification.replaceAll('.','\\.')+'\\s+[1-9]'));
    draining=worker.stop();assert.equal(worker.ended(),false);
  }finally{release();await barrier;}
  await draining;assert.equal(await db.notification.notification.count({where:{relatedAppointmentId:appointmentId}}),1);
  const event=await db.clinic.outboxEvent.findFirstOrThrow({where:{envelope:{path:['payload','relatedAppointmentId'],equals:appointmentId}}});assert.ok(await db.notification.inboxEvent.findUnique({where:{consumerName_eventId:{consumerName:'notification-v1',eventId:event.envelope.eventId}}}));
});
test('Core drains a genuine SQL-blocked in-flight profile write before disconnecting, using owned parent IPC on Windows',async()=>{
  let release,locked;const hold=new Promise(r=>release=r),acquired=new Promise(r=>locked=r);
  const barrier=db.core.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM users WHERE id=${users[0].id} FOR UPDATE`;locked();await hold;},{timeout:15000});
  await acquired;let response,draining;
  try{
    const pending=request('/api/auth/me',{base:coreApis[1].base,method:'PATCH',body:{fullName:'P6 drained '+short,email:users[0].email}});
    await until(async()=>{const [row]=await db.core.$queryRaw`SELECT count(*) AS count FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%UPDATE%'`;return Number(row.count)>0;},'actual SQL write lock waiter',5000);
    draining=coreApis[1].stop();assert.equal(coreApis[1].ended(),false);release();await barrier;response=await pending;await draining;
  }finally{release();await barrier;}
  expectStatus(response,200);assert.equal((await db.core.user.findUniqueOrThrow({where:{id:users[0].id}})).fullName,'P6 drained '+short);assert.ok(coreApis[1].logs().includes('drained'));
});
