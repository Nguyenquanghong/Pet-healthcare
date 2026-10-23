import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import amqp from 'amqplib';
import {topology,declareTopology,publishConfirmed} from '@nipopeto/messaging';
import {assertTestProject,waitForQueueIdle} from './test-project.mjs';
import {createEnvironment,client,url,assertDatabase,backupAndRestore,withDatabase} from './p7-environment.mjs';
import {legacyFixture} from './p7-fixture.mjs';
import {catalogs,sourceNames,digest,readRows} from './p7-manifest.mjs';
import {seal,exportMigration,buildMigration,inspectMigration,importMigration,validateMigration,assertFrozenSource} from './p7-migration.mjs';
import {freezeLegacy,rollbackBeforeOpen,targetPermissions,openTarget,pauseTarget,forwardFix,cutoverState} from './p7-cutover.mjs';
import {initializeAppointmentProjection} from '../../services/clinic/dist/readRevision.js';
import {AppointmentProjector} from '../../services/clinic/dist/appointmentProjector.js';

assert.equal(process.env.PHASE2_TEST_CONFIRM,'pet-phase2-p1-test');assertTestProject();
process.env.CLINIC_READ_PROJECTION='on';// the P7 rehearsal covers the maintained projection (default is off)
const invocation=randomUUID(),contextFile='test-results/phase2/p7-'+invocation+'-context.json',handles=[],tokens={},ports={},origins={};
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',prefix='p7.migration.'+invocation,routes=topology(prefix);
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),secretNames=['CORE_DIRECTORY_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_NOTIFICATION_SEND_TOKEN'];
const secrets=Object.fromEntries(secretNames.map(name=>[name,'p7-'+randomUUID()]));
const common={PHASE2_RUNTIME_REQUIRED:'1',JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_PRIVATE_KEY:'',JWT_SECRET:'',JWT_KEY_ID:'p7-test-1',JWT_ISSUER:'p7-core',JWT_AUDIENCE:'pet-healthcare',REDIS_URL:'redis://127.0.0.1:6389',RATE_LIMIT_NAMESPACE:'p7-'+invocation,RATE_LIMIT_KEY_SECRET:'p7-key-'+randomUUID(),OBSERVABILITY_TOKEN:'p7-observe-'+randomUUID(),BROKER_URL:broker,BROKER_PREFIX:prefix,DB_POOL_LIMIT:'2',TRUST_PROXY_HOPS:'',TRUST_PROXY_CIDRS:'',CLINIC_SERVICE_TOKEN:'',NOTIFICATION_SERVICE_TOKEN:'',...Object.fromEntries(secretNames.map(n=>[n,''])),PAYMENTS_DEMO:'1',VNPAY_ENABLED:'false',VNPAY_TMN_CODE:'',VNPAY_HASH_SECRET:'',BANK_TRANSFER_ENABLED:'false'};
let ctx,fixture,snapshot,expected,db={},nginx,gateway,artifacts,legacyApi,coreApi,clinicApi,notificationApi,declared=false,mode='legacy',maintenance=false,workerHandles=[],newInvoice,newAppointment,newPet,newOwner;
const binary=process.env.P6_NGINX_BINARY??(process.platform==='win32'?resolve('test-results/phase2/tooling/nginx-1.30.5/nginx.exe'):'nginx');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await pause(50);}throw new Error('P7_TIMEOUT_'+label);}
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function child(file,extra,name,ready){
  const c=spawn(process.execPath,[file],{env:{...process.env,...common,...extra},stdio:['ignore','pipe','pipe','ipc']});let logs='',ended=false,expectedExit=false;
  c.stdout.on('data',b=>logs+=b);c.stderr.on('data',b=>logs+=b);c.once('exit',(code,signal)=>{ended=true;writeFileSync(resolve(artifacts,name+'-'+c.pid+'.log'),logs);process.stdout.write(JSON.stringify({component:name,code,signal,expected:expectedExit})+'\n');});
  const h={base:'http://127.0.0.1:'+extra.PORT,stop:async()=>{if(!ended){expectedExit=true;c.send({type:'shutdown'});await until(()=>ended,'drain_'+name,15000);}assert.equal(c.exitCode,0,'Owned P7 child exit: '+name);},logs:()=>logs,kill:async()=>{if(!ended){c.kill();await once(c,'exit');}},ended:()=>ended};handles.push(h);
  await until(async()=>{if(ended)throw new Error('P7_CHILD_STARTUP_'+name);return ready?ready(h):logs.includes('worker-ready');},'ready_'+name);return h;
}
async function request(path,{base=gateway,token=tokens.owner,method='GET',body,key}={}){const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(16000)});return{status:r.status,body:r.status===204?null:await r.json(),headers:r.headers};}
const status=(r,n)=>{assert.equal(r.status,n,'P7 HTTP result');return r.body;};
async function configureGateway(nextMode,paused){
  mode=nextMode;maintenance=paused;const upstream=mode==='legacy'?origins.legacy:origins.core,marker=mode+(paused?'-maintenance':'-open');
  const config=`worker_processes 1;\npid logs/nginx.pid;error_log logs/error.log crit;events {worker_connections 256;}http {access_log off;client_max_body_size 8m;keepalive_timeout 0;proxy_connect_timeout 1s;proxy_read_timeout 15s;proxy_send_timeout 15s;server {listen 127.0.0.1:${ports.gateway};add_header X-P7-Gateway '${marker}' always;default_type application/json;location ~ ^/(internal|metrics|health) {return 404 '{"error":"Private route"}';}location /api/ {${paused?'if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {return 503 \'{"error":"Migration maintenance; retry later."}\';}':''}proxy_pass ${upstream};}location / {return 404 '{}';}}}`;
  writeFileSync(resolve(artifacts,'nginx.conf'),config);const args=['-p',artifacts.replaceAll('\\','/')+'/','-c','nginx.conf'];execFileSync(binary,['-t',...args],{stdio:'pipe'});
  if(!nginx){nginx=spawn(binary,[...args,'-g','daemon off;'],{stdio:'pipe'});nginx.stdout.resume();nginx.stderr.resume();}
  else execFileSync(binary,[...args,'-s','reload'],{stdio:'pipe'});
  await until(async()=>{try{return (await fetch(gateway+'/api/openapi.json')).headers.get('x-p7-gateway')===marker;}catch{return false;}},'gateway_'+marker);
}
async function startTargets(){
  coreApi=await child('backend/dist/src/index.js',{...secrets,JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),DATABASE_URL:url(ctx,'core'),PORT:String(ports.core),SERVICE_INSTANCE_ID:'p7-core',CLINIC_SERVICE_URL:origins.clinic,NOTIFICATION_SERVICE_URL:origins.notification},'core-api',h=>fetch(h.base+'/health/ready').then(r=>r.status===200).catch(()=>false));
  clinicApi=await child('services/clinic/dist/index.js',{CORE_DIRECTORY_TOKEN:secrets.CORE_DIRECTORY_TOKEN,CORE_BILLING_EVIDENCE_TOKEN:secrets.CORE_BILLING_EVIDENCE_TOKEN,CLINIC_BILLING_TOKEN:secrets.CLINIC_BILLING_TOKEN,CLINIC_BOOTSTRAP_TOKEN:secrets.CLINIC_BOOTSTRAP_TOKEN,CORE_SERVICE_URL:origins.core,DATABASE_URL:url(ctx,'clinic'),PORT:String(ports.clinic)},'clinic-api',h=>fetch(h.base+'/health/ready').then(r=>r.status===200).catch(()=>false));
  notificationApi=await child('services/notification/dist/index.js',{CORE_NOTIFICATION_SEND_TOKEN:secrets.CORE_NOTIFICATION_SEND_TOKEN,CORE_SERVICE_URL:origins.core,DATABASE_URL:url(ctx,'notification'),PORT:String(ports.notification)},'notification-api',h=>fetch(h.base+'/health/ready').then(r=>r.status===200).catch(()=>false));
}
async function startWorkers(){
  const stripped={...Object.fromEntries(secretNames.map(n=>[n,''])),JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_KEY_ID:'',JWT_SECRET:'',REDIS_URL:'',RATE_LIMIT_KEY_SECRET:'',OBSERVABILITY_TOKEN:''};
  workerHandles=[await child('backend/dist/src/phase2/notificationWorker.js',{...stripped,DATABASE_URL:url(ctx,'core')},'core-outbox'),await child('services/clinic/dist/worker.js',{...stripped,DATABASE_URL:url(ctx,'clinic'),CORE_SERVICE_URL:origins.core,CORE_DIRECTORY_TOKEN:secrets.CORE_DIRECTORY_TOKEN},'clinic-worker'),await child('services/notification/dist/worker.js',{...stripped,DATABASE_URL:url(ctx,'notification')},'notification-worker'),await child('backend/dist/src/phase2/billingWorker.js',{...stripped,DATABASE_URL:url(ctx,'core'),JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),JWT_PUBLIC_KEY:common.JWT_PUBLIC_KEY,JWT_KEY_ID:common.JWT_KEY_ID,CLINIC_SERVICE_URL:origins.clinic,CLINIC_BILLING_TOKEN:secrets.CLINIC_BILLING_TOKEN},'billing-worker')];
}
async function settled(){await until(async()=>await db.core.outboxEvent.count({where:{publishedAt:null}})===0&&await db.clinic.outboxEvent.count({where:{publishedAt:null}})===0,'outbox_drain');await waitForQueueIdle([routes.clinic,routes.notification]);}
async function replay(events){const conn=await amqp.connect(broker),ch=await conn.createConfirmChannel();try{for(const event of events)await publishConfirmed(ch,routes.exchange,event.eventType,Buffer.from(JSON.stringify(event)),{messageId:event.eventId,contentType:'application/json'});}finally{await ch.close();await conn.close();}await waitForQueueIdle([routes.clinic,routes.notification]);}

test.before(async()=>{
  assert.ok(process.platform!=='win32'||existsSync(binary),'Pinned test nginx prerequisite');ctx=createEnvironment(contextFile);artifacts=resolve('test-results/phase2/p7-'+ctx.run);mkdirSync(resolve(artifacts,'logs'),{recursive:true});mkdirSync(resolve(artifacts,'temp'),{recursive:true});
  fixture=await legacyFixture(ctx);for(const kind of ['legacy','core','clinic','notification']){db[kind]=client(ctx,kind);await assertDatabase(db[kind],ctx,kind);}
  for(const kind of ['legacy','core','clinic','notification','gateway']){ports[kind]=await freePort();origins[kind]='http://127.0.0.1:'+ports[kind];}gateway=origins.gateway;
  legacyApi=await child('tools/phase2/p7-legacy-server.mjs',{P7_CONTEXT_FILE:contextFile,DATABASE_URL:url(ctx,'legacy'),PORT:String(ports.legacy),PHASE2_RUNTIME_REQUIRED:'',REDIS_URL:'',JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_KEY_ID:'',JWT_ISSUER:'',JWT_AUDIENCE:'',JWT_SECRET:'p7-legacy-'+randomUUID(),CLINIC_SERVICE_URL:'',NOTIFICATION_SERVICE_URL:''},'legacy-api',h=>fetch(h.base+'/api/health').then(r=>r.status===200).catch(()=>false));
  await configureGateway('legacy',false);tokens.legacy=status(await request('/api/auth/owner/login',{method:'POST',token:null,body:{email:fixture.users.owner.email,password:fixture.password}}),200).token;tokens.owner=tokens.legacy;
});
test.after(async()=>{
  let failure;
  if(declared)try{await settled();}catch(e){failure=e;}
  for(const h of handles.reverse())try{await h.stop();}catch(e){failure??=e;await h.kill();}
  if(nginx)try{execFileSync(binary,['-p',artifacts.replaceAll('\\','/')+'/','-c','nginx.conf','-s','quit'],{stdio:'pipe'});await until(()=>nginx.exitCode!==null,'nginx_exit',15000);assert.equal(nginx.exitCode,0);}catch(e){failure??=e;nginx.kill();}
  if(declared)try{const conn=await amqp.connect(broker),ch=await conn.createChannel();try{for(const name of [routes.clinic,routes.notification,routes.clinic+'.dlq',routes.notification+'.dlq']){const q=await ch.checkQueue(name);if(q.messageCount!==0)failure??=new Error('P7_NONEMPTY_QUEUE_RETAINED');if(!failure&&q.messageCount===0&&q.consumerCount===0)await ch.deleteQueue(name);}if(!failure)await ch.deleteExchange(routes.exchange);}finally{await ch.close();await conn.close();}}catch(e){failure??=e;}
  for(const h of handles){assert.ok(!/postgresql:\/\/|amqp:\/\/|BEGIN PRIVATE KEY|P7-fixture-only/.test(h.logs()),'No credential in owned child logs');for(const secret of [...Object.values(secrets),...Object.values(ctx?.components??{}).map(c=>c.password)])assert.ok(!h.logs().includes(secret));}
  await Promise.all(Object.values(db).map(c=>c.$disconnect()));if(failure)throw failure;
});

test('fresh marked source and targets use non-owner roles; original monolith credentials and all legacy model fields are present',async()=>{
  assert.equal(sourceNames.length,20);// + AQ-10 HotelRoomCapacity, HotelRoomNightassert.equal((await db.legacy.appointment.findMany()).length,10);
  assert.ok(status(await request('/api/pets'),200).items.some(p=>p.id===fixture.pet.id));
  for(const kind of ['legacy','core','clinic','notification']){const [role]=await db[kind].$queryRaw`SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false});const owners=await db[kind].$queryRaw`SELECT tableowner FROM pg_tables WHERE schemaname='runtime'`;assert.ok(owners.every(r=>r.tableowner==='p2_bootstrap'));}
});
test('maintenance blocks public writes; SQL fence waits for an actual in-flight source transaction before the final consistent export',async()=>{
  await configureGateway('legacy',true);status(await request('/api/pets',{method:'POST',body:{name:'Blocked fixture',species:'dog'}}),503);
  let release,locked;const holding=new Promise(r=>release=r),acquired=new Promise(r=>locked=r);
  const barrier=db.legacy.$transaction(async tx=>{await tx.user.update({where:{id:fixture.users.owner.id},data:{address:'P7 last in-flight value',updatedAt:new Date('2026-01-01T00:00:00Z')}});locked();await holding;},{timeout:15000});await acquired;
  const frozen=freezeLegacy(ctx);try{await withDatabase(ctx,'legacy',async admin=>{await until(async()=>{const [r]=await admin.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%LOCK TABLE%'`;return r.count>0;},'freeze_lock',4000);},{admin:true});}finally{release();await barrier;}await frozen;
  await assert.rejects(()=>db.legacy.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`);
  snapshot=await exportMigration(ctx,{evidence:fixture.evidence});expected=buildMigration(snapshot,ctx);assert.equal(snapshot.tables.User.find(u=>u.id===fixture.users.owner.id).address,'P7 last in-flight value');writeFileSync(resolve(artifacts,'snapshot.json'),JSON.stringify(snapshot),{flag:'wx'});
});
test('real custom-format pg_dump restores successfully to a new database and all 20 models, IDs, decimals, JSON nulls and timestamps match',async()=>{
  const backup=await backupAndRestore(ctx);assert.ok(backup.bytes>1000);
  const restored=await exportMigration(ctx,{component:'restore',evidence:fixture.evidence});assert.equal(digest(restored.tables),digest(snapshot.tables));assert.deepEqual(restored.source.sequence,snapshot.source.sequence);writeFileSync(resolve(artifacts,'restore-report.json'),JSON.stringify({backup,models:18,tablesHash:digest(restored.tables),exact:true}));
});
test('dry-run rejects checksum/field/type, orphan, slot, invoice, history, ambiguous notification and stale snapshot errors before any import',async()=>{
  const bad=(mutate,pattern)=>{const {sha256,...body}=structuredClone(snapshot);mutate(body);assert.throws(()=>buildMigration(seal(body),ctx),pattern);};
  assert.throws(()=>buildMigration({...snapshot,sha256:'0'.repeat(64)},ctx),/CHECKSUM/);
  bad(s=>s.tables.MedicalImage[0].pet_id=randomUUID(),/IMAGE_PET_ORPHAN/);bad(s=>s.tables.Appointment[1].doctor_id=randomUUID(),/DOCTOR_ORPHAN/);
  bad(s=>{const [a,b]=s.tables.Appointment.filter(a=>!['cancelled','no_show'].includes(a.status));b.appointment_time=a.appointment_time;b.appointment_date=a.appointment_date;b.pet_id=a.pet_id;},/DUPLICATE_SLOT/);
  bad(s=>s.tables.Invoice[0].total_amount='0.00',/INVOICE_TOTAL/);bad(s=>s.tables.Invoice[0].owner_id=fixture.users.other.id,/OWNER_PET_ORPHAN/);
  bad(s=>s.tables.InvoiceItem[0].amount='1.00',/ITEM_AMOUNT/);bad(s=>s.tables.PaymentAttempt[0].amount='1.00',/PAYMENT_AMOUNT/);
  bad(s=>s.tables.Invoice[0].subtotal='1.23',/INVALID_VND/);
  bad(s=>s.tables.BookingStatusEvent[0].kind='unknown',/HISTORY_KIND_OR_REVISION/);bad(s=>s.tables.User[0].unknown='x',/UNCLASSIFIED_SOURCE_FIELD/);
  bad(s=>s.tables.Pet[0].species='fish',/INVALID_ENUM/);bad(s=>s.tables.Appointment[0].appointment_date='2026-02-30',/INVALID_DATE/);
  bad(s=>s.evidence.notificationEvents={},/AMBIGUOUS_NOTIFICATION/);
  bad(s=>{const e=s.tables.OutboxEvent.find(e=>e.envelope.value.eventType==='notification.requested.v1');e.id=randomUUID();},/OUTBOX_EVENT_ID/);
  bad(s=>{const e=s.tables.OutboxEvent.find(e=>e.envelope.value.payload.notificationId===fixture.notifications[1].id);e.envelope.value.payload.relatedPetId=fixture.otherPet.id;},/NOTIFICATION_EVENT_COLLISION/);
  bad(s=>{const billed=s.tables.Appointment.find(a=>s.tables.Invoice.some(i=>i.appointment_id===a.id));billed.updated_at='2026-02-01T00:00:00.000Z';},/HISTORICAL_SNAPSHOT_REVIEW/);
  const result=await inspectMigration(ctx,snapshot);assert.equal(result.target.clinic.AppointmentReservation.count,2);assert.equal(result.target.core.BookingStatusEvent.count,1);assert.equal(result.target.clinic.BookingStatusEvent.count,11);assert.ok(Object.values(result.inspection).every(r=>r.empty));
  const {sha256,...changed}=structuredClone(snapshot);changed.tables.DailyCareNote[0].note='Different reviewed source';await assert.rejects(()=>inspectMigration(ctx,seal(changed)),/FROZEN_SOURCE_DRIFT/);
  const cli=JSON.parse(execFileSync(process.execPath,['tools/phase2/migrate-p7.mjs','dry-run',contextFile,resolve(artifacts,'snapshot.json')],{env:{...process.env,PHASE2_TEST_CONFIRM:'pet-phase2-p1-test'},encoding:'utf8'}));assert.equal(cli.snapshotHash,snapshot.sha256);
  writeFileSync(resolve(artifacts,'reviewed-evidence.json'),JSON.stringify(fixture.evidence),{flag:'wx'});
  const exported=JSON.parse(execFileSync(process.execPath,['tools/phase2/migrate-p7.mjs','export',contextFile,resolve(artifacts,'cli-snapshot.json'),resolve(artifacts,'reviewed-evidence.json')],{env:{...process.env,PHASE2_TEST_CONFIRM:'pet-phase2-p1-test'},encoding:'utf8'}));assert.match(exported.snapshotHash,/^[0-9a-f]{64}$/);
});
test('fault rolls back one service import; journaled resume preserves hashes, history reversals, source snapshots, INVOICED reservations and sequence',async()=>{
  await assert.rejects(()=>importMigration(ctx,snapshot,(kind,name)=>{if(kind==='clinic'&&name==='MedicalRecord')throw new Error('P7_INJECTED_IMPORT_FAILURE');}),/P7_INJECTED/);
  assert.equal(await db.core.invoice.count(),3);assert.equal(await db.clinic.appointment.count(),0);assert.equal(await db.notification.notification.count(),0);
  const report=await importMigration(ctx,snapshot);assert.ok(Object.values(report.validation).every(r=>r.exact));await importMigration(ctx,snapshot);
  await withDatabase(ctx,'core',async c=>{for(const name of ['Appointment','MedicalRecord','MedicalImage','Notification'])assert.equal((await readRows(c,catalogs.core[name])).length,0);},{admin:true});
  assert.equal(await db.clinic.appointmentReservation.count({where:{state:'INVOICED'}}),2);
  assert.equal(await db.clinic.clinicReadRevision.count({where:{kind:'appointment',version:1,deleted:false}}),await db.clinic.appointment.count());
  const [seq]=await withDatabase(ctx,'core',c=>c.$queryRaw`SELECT last_value::text AS value FROM runtime.invoice_transfer_code_seq`,{admin:true});assert.ok(BigInt(seq.value)>=9002n);
  const nulls=await db.core.$queryRaw`SELECT id,bank_transfer_details IS NULL AS sql_null,bank_transfer_details='null'::jsonb AS json_null FROM runtime.invoices`;assert.ok(nulls.find(r=>r.id===fixture.invoices[0].id).sql_null);assert.equal(nulls.find(r=>r.id===fixture.invoices[2].id).json_null,true);
  writeFileSync(resolve(artifacts,'migration-report.json'),JSON.stringify(report,null,2));
});
test('read-only target gateway serves migrated records with fresh auth/scope/redaction; runtime cannot access moved Core tables or another database',async()=>{
  const configured=JSON.parse(execFileSync(process.execPath,['tools/phase2/migrate-p7.mjs','read-only-target',contextFile],{env:{...process.env,PHASE2_TEST_CONFIRM:'pet-phase2-p1-test'},encoding:'utf8'}));assert.equal(configured.command,'read-only-target');await startTargets();await configureGateway('target',true);
  status(await request('/api/auth/me',{token:tokens.legacy}),401);
  for(const name of ['owner','other','admin'])tokens[name]=status(await request('/api/auth/'+(name==='admin'?'admin':'owner')+'/login',{base:origins.core,method:'POST',token:null,body:name==='admin'?{username:fixture.users.admin.username,password:fixture.password}:{email:fixture.users[name].email,password:fixture.password}}),200).token;
  const list=status(await request('/api/appointments?pageSize=2&page=1'),200);assert.equal(list.items.length,2);assert.equal(list.pagination.total,10);
  const records=status(await request('/api/medical-records?petId='+fixture.pet.id),200);assert.equal(records.items[0].id,fixture.medical.id);assert.equal(Object.hasOwn(records.items[0],'internalNote'),false);
  status(await request('/api/medical-records?petId='+fixture.pet.id,{token:tokens.other}),403);
  const images=status(await request('/api/medical-records/images?petId='+fixture.pet.id),200);assert.equal(images.items[0].id,fixture.image.id);assert.equal(images.items[0].url,null);assert.ok(!('imageUrl'in images.items[0]));// AQ-09: migrated base64 rows list without content until the blob migration tool runs
  const invoices=status(await request('/api/invoices'),200);assert.equal(invoices.items.length,3);assert.equal(invoices.items.find(i=>i.id===fixture.invoices[0].id).paymentStatus,'paid');
  const notices=status(await request('/api/notifications'),200);assert.equal(notices.items.find(n=>n.id===fixture.notifications[1].id).status,'read');
  for(const table of ['appointments','medical_records','medical_images','notifications'])await assert.rejects(()=>db.core.$queryRawUnsafe('SELECT count(*) FROM runtime."'+table+'"'));
  await assert.rejects(()=>db.core.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`);
  for(const kind of ['core','clinic','notification'])for(const other of ['core','clinic','notification'].filter(k=>k!==kind)){const destination=new URL(url(ctx,kind));destination.pathname='/'+ctx.components[other].database;const badClient=new db[kind].constructor({datasourceUrl:destination.toString()});try{await assert.rejects(()=>badClient.$queryRaw`SELECT 1`,/denied|access|P1010/i);}finally{await badClient.$disconnect();}}
});
test('rollback before opening target re-enables only the legacy writer; re-freeze refuses stale source and resumes the same unchanged snapshot',async()=>{
  await configureGateway('target',true);await rollbackBeforeOpen(ctx);await configureGateway('legacy',false);
  status(await request('/api/auth/me',{token:tokens.legacy}),200);await db.legacy.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`;
  await assert.rejects(()=>db.core.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`);
  await configureGateway('legacy',true);await freezeLegacy(ctx);await assertFrozenSource(ctx,snapshot);await importMigration(ctx,snapshot);await configureGateway('target',true);
});
test('opening target preserves old invoice/activation contracts and completes a new registration→pet→exam→medical→invoice→notification journey',async()=>{
  await openTarget(ctx,snapshot);await declareTopology(broker,routes);declared=true;await startWorkers();await configureGateway('target',false);
  status(await request('/api/appointments/'+fixture.appointments[6].id+'/undo-status',{method:'POST',token:tokens.admin,body:{expectedRevision:1,reason:'Must remain billed'}}),409);
  const historic=status(await request('/api/invoices/checkout',{method:'POST',key:randomUUID(),body:{type:'appointment',relatedId:fixture.appointments[6].id}}),200).invoice;assert.equal(historic.id,fixture.invoices[1].id);
  status(await request('/api/auth/owner/activation/inspect',{method:'POST',token:null,body:{token:fixture.activationToken}}),200);
  status(await request('/api/auth/owner/activation',{method:'POST',token:null,body:{token:fixture.activationToken,password:fixture.password,confirmPassword:fixture.password}}),200);
  assert.equal((await db.core.pet.findUniqueOrThrow({where:{id:fixture.counterPet.id}})).ownerId,fixture.users.counter.id);
  const email='p7_new_'+ctx.run.slice(0,8)+'@example.test';status(await request('/api/auth/owner/register',{method:'POST',token:null,body:{fullName:'P7 newly registered',email,password:fixture.password,confirmPassword:fixture.password}}),201);
  const login=status(await request('/api/auth/owner/login',{method:'POST',token:null,body:{email,password:fixture.password}}),200);newOwner=login.user.id;tokens.new=login.token;
  newPet=status(await request('/api/pets',{method:'POST',token:tokens.new,body:{name:'P7 new pet',species:'cat'}}),201).pet;
  const [readPrivileges]=await db.clinic.$queryRaw`SELECT has_table_privilege(current_user,'runtime."ClinicReadRevision"','INSERT') AS "canInsert",has_table_privilege(current_user,'runtime."ClinicReadRevision"','DELETE') AS "canDelete",has_table_privilege(current_user,'runtime."ReadProjectionControl"','UPDATE') AS "canSwitch"`;
  assert.deepEqual(readPrivileges,{canInsert:true,canDelete:false,canSwitch:false});
  const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10);newAppointment=status(await request('/api/appointments',{method:'POST',token:tokens.new,key:randomUUID(),body:{petId:newPet.id,date:today,time:'15:00',type:'general_checkup',serviceName:'P7 fresh visit'}}),201).appointment;
  for(const state of ['confirmed','checked_in'])newAppointment=status(await request('/api/appointments/'+newAppointment.id+'/status',{method:'PATCH',token:tokens.admin,body:{status:state,expectedRevision:newAppointment.statusRevision}}),200).appointment;
  status(await request('/api/medical-records',{method:'POST',token:tokens.admin,key:randomUUID(),body:{petId:newPet.id,appointmentId:newAppointment.id,doctorName:'P7 synthetic doctor',title:'P7 new record',visitDate:today,diagnosis:'Synthetic',treatment:'Synthetic'}}),201);
  const issued=await request('/api/invoices',{method:'POST',token:tokens.admin,key:randomUUID(),body:{type:'appointment',relatedId:newAppointment.id,subtotal:450000,taxAmount:0,discountAmount:0}});assert.ok([201,202].includes(issued.status));
  if(issued.status===201)newInvoice=issued.body.invoice;else{await until(async()=>{const r=status(await request('/api/operations/'+issued.body.operationId,{token:tokens.admin}),200);if(r.status==='succeeded'){newInvoice=r.invoice;return true;}return false;},'invoice_committed');}
  await until(async()=>Boolean(await db.clinic.appointmentReservation.findFirst({where:{appointmentId:newAppointment.id,state:'INVOICED'}})),'reservation_finalized');
  await settled();const notices=status(await request('/api/notifications',{token:tokens.new}),200);assert.ok(notices.items.some(n=>n.relatedAppointmentId===newAppointment.id));assert.equal(await db.core.invoice.count({where:{appointmentId:newAppointment.id}}),1);
  await assert.rejects(()=>db.legacy.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`);
});
test('real broker replay keeps imported read/deleted notices and preserves a reviewed pending intent exactly once; directory catch-up uses current versions',async()=>{
  await settled();const deleted=fixture.events.find(e=>fixture.evidence.notificationEvents[e.eventId]==='deleted'),pending=fixture.events.find(e=>fixture.evidence.notificationEvents[e.eventId]==='pending');
  assert.equal(await db.notification.notification.count({where:{id:deleted.payload.notificationId}}),0);assert.equal(await db.notification.notification.count({where:{id:pending.payload.notificationId}}),1);
  status(await request('/api/notifications/'+fixture.notifications[1].id,{method:'DELETE'}),204);
  await replay(fixture.events);assert.equal(await db.notification.notification.count({where:{id:fixture.notifications[1].id}}),0);assert.equal(await db.notification.notification.count({where:{id:deleted.payload.notificationId}}),0);assert.equal(await db.notification.notification.count({where:{id:pending.payload.notificationId}}),1);
  for(const [kind,id]of [['owner',newOwner],['pet',newPet.id]]){const source=kind==='owner'?await db.core.user.findUniqueOrThrow({where:{id}}):await db.core.pet.findUniqueOrThrow({where:{id}});assert.equal((await db.clinic.directoryProjection.findUniqueOrThrow({where:{kind_id:{kind,id}}})).sourceVersion,source.directoryRevision);}
});
test('after target writes rollback is durably refused; maintenance/drain/restart/forward-fix preserves new clinical and financial records',async()=>{
  await configureGateway('target',true);await settled();for(const h of workerHandles.reverse())await h.stop();workerHandles=[];await coreApi.stop();await pauseTarget(ctx);
  await assert.rejects(()=>rollbackBeforeOpen(ctx),/ROLLBACK_AFTER_OPEN/);assert.equal((await cutoverState(ctx)).state,'TARGET_PAUSED');await assert.rejects(()=>db.legacy.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`);
  assert.throws(()=>execFileSync(process.execPath,['tools/phase2/migrate-p7.mjs','read-only-target',contextFile],{env:{...process.env,PHASE2_TEST_CONFIRM:'pet-phase2-p1-test'},encoding:'utf8',stdio:'pipe'}),error=>JSON.parse(error.stderr).code==='P7_READ_ONLY_AFTER_OPEN_USE_PAUSE');
  assert.equal((await db.core.invoice.findUniqueOrThrow({where:{id:newInvoice.id}})).totalAmount.toString(),'450000');assert.equal(await db.clinic.medicalRecord.count({where:{appointmentId:newAppointment.id}}),1);
  await forwardFix(ctx);coreApi=await child('backend/dist/src/index.js',{...secrets,JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),DATABASE_URL:url(ctx,'core'),PORT:String(ports.core),SERVICE_INSTANCE_ID:'p7-core-forward-fix',CLINIC_SERVICE_URL:origins.clinic,NOTIFICATION_SERVICE_URL:origins.notification},'core-forward-fix',h=>fetch(h.base+'/health/ready').then(r=>r.status===200).catch(()=>false));await startWorkers();await configureGateway('target',false);
  status(await request('/api/medical-records?petId='+newPet.id,{token:tokens.new}),200);assert.equal((await db.core.invoice.findUniqueOrThrow({where:{id:newInvoice.id}})).ownerId,newOwner);await settled();assert.equal(await db.core.invoice.count({where:{appointmentId:newAppointment.id}}),1);
  const active=await db.clinic.$queryRaw`SELECT count(*)::int AS count FROM (SELECT pet_id,appointment_date,appointment_time FROM runtime.appointments WHERE status NOT IN ('cancelled','no_show') GROUP BY 1,2,3 HAVING count(*)>1) q`;assert.equal(active[0].count,0);
  const allInvoices=await db.core.invoice.findMany({where:{appointmentId:{not:null}}});for(const invoice of allInvoices){const reservation=await db.clinic.appointmentReservation.findFirstOrThrow({where:{appointmentId:invoice.appointmentId,state:'INVOICED'}});assert.equal(reservation.invoiceId,invoice.id);}
  writeFileSync(resolve(artifacts,'cutover-report.json'),JSON.stringify({sourceWriterFenced:true,targetWriterOnly:true,beforeOpenRollback:true,afterOpenRollbackRejected:true,forwardFix:true,newInvoiceCount:1,clinicalInvoiceReservations:allInvoices.length,sourceModels:18,restoreExact:true,historySplit:true,notificationReplay:true,gateway:'actual nginx reload',liveDatabaseTouched:false}));
});

test('concurrent pause and forward-fix wait on an actual SQL barrier and leave ledger and writer grants consistent',async()=>{
  await configureGateway('target',true);await settled();for(const h of workerHandles.reverse())await h.stop();workerHandles=[];
  let release,acquired;const held=new Promise(r=>release=r),ready=new Promise(r=>acquired=r);
  const barrier=withDatabase(ctx,'legacy',admin=>admin.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(710008)::text`;acquired();await held;},{timeout:15000}),{admin:true});await ready;
  const paused=pauseTarget(ctx),fixed=forwardFix(ctx);
  try{await withDatabase(ctx,'legacy',async admin=>{await until(async()=>{const [row]=await admin.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%710008%'`;return row.count>=2;},'cutover_waiters',4000);},{admin:true});}finally{release();await barrier;}
  await Promise.all([paused,fixed]);const gate=await cutoverState(ctx);
  const [grant]=await db.core.$queryRaw`SELECT has_table_privilege(current_user,'runtime.daily_care_notes','UPDATE') AS writable`;assert.equal(grant.writable,gate.state==='TARGET_OPEN');
  await assert.rejects(()=>rollbackBeforeOpen(ctx),/ROLLBACK_AFTER_OPEN/);await assert.rejects(()=>db.legacy.$executeRaw`UPDATE runtime.daily_care_notes SET note=note`);
  await forwardFix(ctx);await startWorkers();await configureGateway('target',false);await settled();
});

test('non-owner Clinic projector locks control and commits rows but cannot switch serving mode; pause revokes column grants',async()=>{
  await configureGateway('target',true);await settled();for(const h of workerHandles.reverse())await h.stop();workerHandles=[];
  const generation=randomUUID();
  const [fenceAcl]=await db.clinic.$queryRaw`SELECT has_table_privilege(current_user,'runtime."ReadRebuildRun"','SELECT') AS "canRead",has_table_privilege(current_user,'runtime."ReadRebuildRun"','UPDATE') AS "canWrite"`;
  assert.deepEqual(fenceAcl,{canRead:true,canWrite:false});
  await assert.rejects(()=>db.clinic.readRebuildRun.create({data:{id:randomUUID(),generation:randomUUID(),ownerPid:1}}),/permission denied/);
  await withDatabase(ctx,'clinic',admin=>initializeAppointmentProjection(admin,generation),{admin:true});
  const changes=await db.clinic.outboxEvent.findMany();
  const event=changes.map(row=>row.envelope).find(e=>e.eventType==='clinic.appointment-read-changed.v1'&&e.aggregateId===newAppointment.id);
  assert.ok(event);
  const projector=new AppointmentProjector(db.clinic);
  assert.equal(await projector.apply(JSON.stringify(event)),true);
  const row=await db.clinic.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation,appointmentId:newAppointment.id}}});
  const revision=await db.clinic.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:newAppointment.id}}});
  assert.equal(row.sourceVersion,revision.version);assert.equal(row.billingInvoiced,true);
  await assert.rejects(()=>db.clinic.$executeRaw`UPDATE "ReadProjectionControl" SET "servingMode"='projection' WHERE "projectionName"='appointments'`,/permission denied/);
  await assert.rejects(()=>db.clinic.$executeRaw`UPDATE "ReadProjectionControl" SET "activeGenerationId"=${generation} WHERE "projectionName"='appointments'`,/permission denied/);
  await pauseTarget(ctx);
  const [privileges]=await db.clinic.$queryRaw`SELECT has_column_privilege(current_user,'runtime."ReadProjectionControl"','lockAnchor','UPDATE') AS "canLock"`;
  assert.equal(privileges.canLock,false);
  await assert.rejects(()=>projector.apply(JSON.stringify(event)),/permission denied/);
  await forwardFix(ctx);assert.equal(await projector.apply(JSON.stringify(event)),false);
});
