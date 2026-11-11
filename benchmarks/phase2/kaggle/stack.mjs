// Dedicated native Kaggle fixture. Does not modify the Compose/E2E guards.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,mkdirSync,openSync,closeSync,renameSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID,generateKeyPairSync,randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {PrismaClient as Core} from '@prisma/client';
import {PrismaClient as Clinic} from '../../../services/clinic/src/generated/client/index.js';
import {PrismaClient as Notification} from '../../../services/notification/src/generated/client/index.js';
import {hashPasswordAsync} from '../../../backend/dist/src/lib/password.js';
import {createDataset} from '../dataset.mjs';
const context=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.equal(process.platform,'linux');
assert.equal(context.kind,'phase2-kaggle-native-v1');
assert.match(context.run,/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
const dir=realpathSync(context.directory);
assert.equal(dir,'/tmp/pet-phase2-kaggle-'+context.run);
assert.equal(dirname(realpathSync(process.argv[2])),dir);
assert.equal(realpathSync(context.pgData),dir+'/pgdata');
assert.ok([1,2].includes(context.replicas));
// Bridge VM study: Core instances (H2) and the nginx hop Clinic and Notification use to reach Core (every H configuration, so H0/H1/H2 differ only
// in product code and instance count). Absent in every older context: one Core, listening on ports.core itself and called directly.
const coreReplicas=context.coreReplicas??1;
assert.ok([1,2].includes(coreReplicas));
assert.ok(context.coreProxy===undefined||typeof context.coreProxy==='boolean');
const coreProxy=context.coreProxy===true||coreReplicas>1;
// Bridge VM study (K9), Notification workers on the one notification queue: 1 or 2, never with a CQRS configuration. RabbitMQ deals the messages round-robin (prefetch 1 per worker);
// a message redelivered to the other worker is applied once, as InboxEvent(consumerName,eventId) is inserted in the effect's own transaction. Absent in every older context: one.
const notificationWorkers=context.notificationWorkers??1;
assert.ok([1,2].includes(notificationWorkers),'context.notificationWorkers must be 1 or 2, got '+JSON.stringify(notificationWorkers));
// Bridge VM study: how the gateway reaches the services. `direct` (the default, and the only one the CQRS studies use) sends each prefix of
// gatewayRoutes straight to its service, as deploy/phase2/nginx.split.conf.example does; `core-ingress` sends every /api path to Core, which
// forwards the owned prefixes itself, as compose, the demo and E2E do (one more hop for Clinic and Notification traffic; K9 H3c).
const gatewayTopology=context.gatewayTopology??'direct';
assert.ok(['direct','core-ingress'].includes(gatewayTopology),'context.gatewayTopology must be direct or core-ingress, got '+JSON.stringify(gatewayTopology));
// Bridge VM study, where this tree keeps the Core workers: `workers` is the tree of today (H3), `phase2` the tree of 2841d1b (H1), before backend/src/phase2 was split up.
// Exactly one layout must be built in the tree stack.mjs runs from (the paths are relative to the repository, as every child below), and context.coreLayout must name it.
// Absent in every older context: workers.
const CORE_LAYOUTS={workers:{notification:'backend/dist/src/workers/notification.js',billing:'backend/dist/src/workers/billing.js'},phase2:{notification:'backend/dist/src/phase2/notificationWorker.js',billing:'backend/dist/src/phase2/billingWorker.js'}};
const coreLayout=context.coreLayout??'workers';
const builtLayouts=Object.keys(CORE_LAYOUTS).filter(name=>Object.values(CORE_LAYOUTS[name]).every(file=>existsSync(file)));
assert.deepEqual(builtLayouts,[coreLayout],'context.coreLayout is '+JSON.stringify(coreLayout)+' but the tree has the Core worker layout(s) '+JSON.stringify(builtLayouts)+' (workers: backend/dist/src/workers, phase2: backend/dist/src/phase2)');
// Bridge VM study, the Prisma pool of every service process (DB_POOL_LIMIT, the pool the H3p8 block widens): 4 to 8, 4 in every older context.
const dbPoolLimit=context.dbPoolLimit??4;
assert.ok(Number.isInteger(dbPoolLimit)&&dbPoolLimit>=4&&dbPoolLimit<=8,'context.dbPoolLimit must be an integer from 4 to 8, got '+JSON.stringify(dbPoolLimit));
const cleanEnv=Object.fromEntries(['PATH','HOME','LANG','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
// Apps import dotenv; an existing file must not inject a target or secret.
for(const file of ['.env','backend/.env','services/clinic/.env','services/notification/.env']){
  try{readFileSync(file);throw new Error('Remove private env from the uploaded source: '+file);}catch(e){if(e.code!=='ENOENT')throw e;}
}
const socketEnv={...cleanEnv,PGHOST:dir,PGPORT:String(context.pgPort),PGUSER:'postgres'};
const data=execFileSync('psql',['-At','-c','SHOW data_directory'],{env:socketEnv,encoding:'utf8'}).trim();
assert.equal(realpathSync(data),context.pgData);
const clients={core:Core,clinic:Clinic,notification:Notification},db={},handles=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const dump=(file,value)=>{const temporary=resolve(dir,file+'.tmp');writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600});renameSync(temporary,resolve(dir,file));};
async function until(check,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw new Error('Timeout '+label);}
async function port(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
let failed=false,stopping=false,nginx;
async function stop(handle){
  if(handle.child.exitCode!==null){if(handle.child.exitCode!==0)failed=true;return;}
  handle.expected=true;
  handle.child.send({type:'shutdown'});
  try{await until(()=>handle.child.exitCode!==null,'shutdown',15000);}catch{handle.child.kill('SIGKILL');failed=true;}
  if(handle.child.exitCode!==0)failed=true;
}
async function cleanup(){
  if(stopping)return;stopping=true;
  if(nginx&&nginx.exitCode===null){nginx.kill('SIGQUIT');try{await until(()=>nginx.exitCode!==null,'nginx drain',5000);}catch{nginx.kill('SIGKILL');failed=true;}}
  for(const handle of [...handles].reverse())try{await stop(handle);}catch{failed=true;handle.child.kill('SIGKILL');}
  await Promise.allSettled(Object.values(db).map(c=>c.$disconnect()));
}
process.once('SIGTERM',()=>void cleanup().then(()=>process.exit(failed?1:0)));
try{
  for(const [name,Client] of Object.entries(clients)){
    const url=new URL(context.urls[name]);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,String(context.pgPort));
    assert.equal(url.username,'p8_'+name);assert.equal(url.pathname,'/p8_'+name);
    db[name]=new Client({datasourceUrl:url.toString()});
    const [identity]=await db[name].$queryRaw`SELECT current_database() AS db,current_user AS role`;
    assert.equal(identity.db,'p8_'+name);assert.equal(identity.role,'p8_'+name);
    const [marker]=await db[name].$queryRaw`SELECT run FROM p8_control.marker`;
    assert.equal(marker.run,context.run);
    execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',name==='core'?'backend/prisma/schema.prisma':`services/${name}/prisma/schema.prisma`],{env:{...cleanEnv,DATABASE_URL:url.toString()},stdio:'pipe'});
  }
  for(const name of Object.keys(db))for(const other of Object.keys(db))if(name!==other){
    const url=new URL(context.urls[name]);url.pathname='/p8_'+other;
    const denied=new Core({datasourceUrl:url.toString()});let connected=false;
    try{await denied.$connect();connected=true;}catch{}finally{await denied.$disconnect();}
    assert.equal(connected,false,'Cross-service CONNECT must fail');
  }
  const password=randomBytes(24).toString('hex'),hash=await hashPasswordAsync(password);
  const profile=context.datasetProfile??'deep';
  assert.ok(['deep','pcn','query-heavy'].includes(profile));
  const makeDataset=profile==='query-heavy'?(await import('./query_dataset.mjs')).createQueryDataset:profile==='pcn'?(await import('./pcn_dataset.mjs')).createPcnDataset:createDataset;
  const dataset=await makeDataset(db,{run:context.run,hash,count:context.accounts,anchor:new Date()});
  const cqrsMode=context.cqrsConfiguration;
  let cqrs,cqrsTools;
  if(cqrsMode!==undefined&&cqrsMode!==null){
    assert.equal(context.replicas,1);assert.equal(coreReplicas,1);assert.ok(!coreProxy);assert.equal(gatewayTopology,'direct');assert.equal(coreLayout,'workers');assert.equal(dbPoolLimit,4);assert.equal(notificationWorkers,1);assert.ok(['pcn','query-heavy'].includes(profile));
    cqrsTools=await import('./cqrs_runtime.mjs');
    cqrs=await cqrsTools.prepareReadModel(cqrsMode,context.urls.clinic,context);
  }
  const admin=await db.core.user.create({data:{id:randomUUID(),username:'p8_'+context.run,fullName:'Synthetic benchmark admin',role:'admin',...hash}});
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const secret=()=>randomBytes(32).toString('hex');
  const credentials=Object.fromEntries(['CORE_DIRECTORY_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_NOTIFICATION_SEND_TOKEN'].map(k=>[k,secret()]));
  // Read diagnostics are a study aid for the maintained-projection members only; F runs the product defaults.
  const cqrsEnv=cqrsTools?{...cqrsTools.apiEnvironment(cqrsMode,secret()),CLINIC_READ_DIAGNOSTICS:['A','B'].includes(cqrsMode)?'1':'0'}:{CLINIC_READ_DIAGNOSTICS:'0'};
  const common={HOST:'127.0.0.1',PHASE2_RUNTIME_REQUIRED:'1',JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_KEY_ID:'p8-kaggle',JWT_ISSUER:'p8-core',JWT_AUDIENCE:'pet-healthcare',JWT_SECRET:'',REDIS_URL:context.redis,RATE_LIMIT_NAMESPACE:'p8-'+context.run,RATE_LIMIT_KEY_SECRET:secret(),OBSERVABILITY_TOKEN:secret(),DB_POOL_LIMIT:String(dbPoolLimit),HASH_CONCURRENCY:'2',HASH_PENDING_LIMIT:'16',TRUST_PROXY_CIDRS:'',BROKER_URL:context.broker,BROKER_PREFIX:'p8.'+context.run,PAYMENTS_DEMO:'1',VNPAY_ENABLED:'false',BANK_TRANSFER_ENABLED:'false',CORS_ORIGIN:''};
  // Bridge study: raise named limiter thresholds only; the limiter still runs.
  for(const [key,value] of Object.entries(context.serviceEnv??{})){assert.match(key,/^(API|RESCUE_REPORT)_[A-Z_]+_LIMIT$/);assert.match(String(value),/^[0-9]+$/);common[key]=String(value);}
  const ports={core:await port(),notification:await port(),clinic:await port(),gateway:await port()};
  const clinicPorts=[];for(let n=0;n<context.replicas;n++)clinicPorts.push(await port());
  // Without coreProxy the one Core listens on ports.core itself and Clinic and Notification call it directly. With it, ports.core is an nginx listener in front of
  // `upstream core_internal` (keepalive), so their Core calls are balanced across the instances and cost the same hop for one instance or two.
  const corePorts=[];if(!coreProxy)corePorts.push(ports.core);else for(let n=0;n<coreReplicas;n++)corePorts.push(await port());
  const origins=Object.fromEntries(Object.entries(ports).map(([k,v])=>[k,'http://127.0.0.1:'+v]));
  common.CORE_SERVICE_URL=origins.core;common.CLINIC_SERVICE_URL=origins.clinic;common.NOTIFICATION_SERVICE_URL=origins.notification;
  const metrics=[];
  // Every process names its database connections p8-<process> (application_name, which Prisma passes on from the connection string and databaseUrl() keeps),
  // so the pg_stat_activity sampler of the bridge VM study can tell which pool is busy; the monolith member uses m-api.
  const withApplicationName=(url,name)=>{const u=new URL(url);u.searchParams.set('application_name','p8-'+name);return u.toString();};
  async function child(name,file,extra,readyPort){
    const fd=openSync(resolve(dir,name+'.log'),'a',0o600);
    const env={...cleanEnv,...common,...extra};
    if(env.DATABASE_URL)env.DATABASE_URL=withApplicationName(env.DATABASE_URL,name);
    const c=spawn(process.execPath,[file],{env,stdio:['ignore',fd,fd,'ipc']});closeSync(fd);
    const handle={name,child:c,expected:false};handles.push(handle);
    c.once('exit',(code)=>{if(!handle.expected){failed=true;dump('unexpected-exit.json',{name,code});}});
    c.once('error',()=>{failed=true;});
    await until(async()=>{
      if(c.exitCode!==null)throw new Error('Child startup failed: '+name);
      if(readyPort){try{return(await fetch('http://127.0.0.1:'+readyPort+'/health/ready')).status===200;}catch{return false;}}
      return readFileSync(resolve(dir,name+'.log'),'utf8').includes('worker-ready');
    },name);
    if(readyPort)metrics.push({name,origin:'http://127.0.0.1:'+readyPort,pid:c.pid});
    return handle;
  }
  if(cqrs?.projectorEnabled)await child('clinic-read-worker','services/clinic/dist/readWorker.js',{
    JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_KEY_ID:'',JWT_ISSUER:'',JWT_AUDIENCE:'',REDIS_URL:'',RATE_LIMIT_KEY_SECRET:'',OBSERVABILITY_TOKEN:'',
    DATABASE_URL:context.urls.clinic,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1',CLINIC_READ_PROJECTION:'on'});
  // With several Core instances each has its own instance id and metrics origin (as in tools/phase2/resilience.test.mjs) and hashes one password at a time:
  // HASH_CONCURRENCY=1 each keeps two hash slots in all, as with one instance (the 28/10 handoff plan; resilience.test.mjs itself uses 2 per instance).
  for(let i=0;i<corePorts.length;i++)await child(coreReplicas===1?'core':'core-'+i,'backend/dist/src/index.js',{...credentials,JWT_PRIVATE_KEY:privateKey,DATABASE_URL:context.urls.core,PORT:String(corePorts[i]),SERVICE_INSTANCE_ID:coreReplicas===1?'p8-core':'p8-core-'+i,...(coreReplicas>1?{HASH_CONCURRENCY:'1'}:{})},corePorts[i]);
  for(let i=0;i<clinicPorts.length;i++)await child('clinic-'+i,'services/clinic/dist/index.js',{...credentials,...cqrsEnv,CORE_NOTIFICATION_SEND_TOKEN:'',DATABASE_URL:context.urls.clinic,PORT:String(clinicPorts[i]),SERVICE_INSTANCE_ID:'p8-clinic-'+i},clinicPorts[i]);
  await child('notification','services/notification/dist/index.js',{CORE_NOTIFICATION_SEND_TOKEN:credentials.CORE_NOTIFICATION_SEND_TOKEN,DATABASE_URL:context.urls.notification,PORT:String(ports.notification)},ports.notification);
  mkdirSync(resolve(dir,'nginx-temp'));
  const retryHeaders='proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Request-ID $request_id; proxy_connect_timeout 1s; proxy_read_timeout 15s; proxy_next_upstream error timeout http_502 http_503 http_504;';
  // With coreProxy (every H configuration of the bridge VM study, and two Core instances) no location retries on another instance and no upstream server is put aside after a failure,
  // for Core and for Clinic alike (K9 S2): one policy for one instance or two, so a second Clinic changes the capacity and nothing about how errors are handled. `headers` is what the
  // gateway's Clinic and Notification locations and the listener on ports.clinic use, `coreGateway` the gateway's Core location; the two templates below name them and stay as they are.
  // Without coreProxy (the CQRS studies, every older context) both are the plain `retryHeaders` and the upstreams keep nginx's defaults, as ever.
  const headers=coreProxy?retryHeaders.replace('proxy_next_upstream error timeout http_502 http_503 http_504;','proxy_next_upstream off;'):retryHeaders;
  const coreGateway=headers;
  const coreServers=corePorts.map(p=>'server 127.0.0.1:'+p+' max_fails=0;').join(' ');
  const clinicServers=clinicPorts.map(p=>'server 127.0.0.1:'+p+(coreProxy?' max_fails=0':'')+';').join(' ');
  // Clinic and Notification reach Core here (coreProxy): HTTP/1.1 with upstream keepalive (idle 4 s, below Core's 5 s keepAliveTimeout), the caller's request id kept,
  // no retry on another instance (one policy for one Core or two). The gateway's own path to Core (upstream core) has no keepalive, as before.
  const coreEdge=coreProxy?`map $http_x_request_id $core_req_id { default $http_x_request_id; "" $request_id; } upstream core_internal { ${coreServers} keepalive 16; keepalive_timeout 4s; } server { listen 127.0.0.1:${ports.core}; location / { proxy_http_version 1.1; proxy_set_header Connection ""; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Request-ID $core_req_id; proxy_connect_timeout 1s; proxy_read_timeout 15s; proxy_next_upstream off; proxy_pass http://core_internal; } } `:'';
  // Two full templates, one per gateway topology, that differ only in the gateway server (tools/phase2/gateway-routing.mjs reads each against gatewayRoutes
  // and keeps them apart). Both raise the nginx descriptors and connections so the gateway is not the ceiling at 800 users.
  // direct: appointments, medical-records and dashboard/clinic go to Clinic, notifications to Notification, the rest to Core.
  const directConfig=`pid ${dir}/nginx.pid; error_log ${dir}/nginx.log; worker_rlimit_nofile 8192; events { worker_connections 4096; } http { access_log off; client_body_temp_path ${dir}/nginx-temp; proxy_temp_path ${dir}/nginx-temp; upstream clinic { ${clinicServers} } upstream core { ${coreServers} } server { listen 127.0.0.1:${ports.clinic}; location / { ${headers} proxy_pass http://clinic; } } ${coreEdge}server { listen 127.0.0.1:${ports.gateway}; location ~ ^/(internal|metrics|health) { return 404; } location ~ ^/api/(appointments|medical-records|dashboard/clinic)(/|$) { ${headers} proxy_pass http://clinic; } location ~ ^/api/notifications(/|$) { ${headers} proxy_pass ${origins.notification}; } location /api/ { ${coreGateway} proxy_pass http://core; } location / { return 404; } } }`;
  // core-ingress: every /api path goes to Core.
  const coreIngressConfig=`pid ${dir}/nginx.pid; error_log ${dir}/nginx.log; worker_rlimit_nofile 8192; events { worker_connections 4096; } http { access_log off; client_body_temp_path ${dir}/nginx-temp; proxy_temp_path ${dir}/nginx-temp; upstream clinic { ${clinicServers} } upstream core { ${coreServers} } server { listen 127.0.0.1:${ports.clinic}; location / { ${headers} proxy_pass http://clinic; } } ${coreEdge}server { listen 127.0.0.1:${ports.gateway}; location ~ ^/(internal|metrics|health) { return 404; } location /api/ { ${coreGateway} proxy_pass http://core; } location / { return 404; } } }`;
  const config=gatewayTopology==='core-ingress'?coreIngressConfig:directConfig;
  writeFileSync(resolve(dir,'nginx.conf'),config);
  // Fail fast with nginx's own message when the generated config is wrong (skipped only when there is no nginx binary, which the spawn below reports).
  try{execFileSync('nginx',['-t','-p',dir+'/','-c',resolve(dir,'nginx.conf')],{stdio:'pipe'});}
  catch(e){if(e.code!=='ENOENT')throw new Error('nginx -t rejected the generated config: '+String(e.stderr??e.message).trim());}
  const nginxFd=openSync(resolve(dir,'nginx-console.log'),'a',0o600);
  nginx=spawn('nginx',['-p',dir+'/', '-c',resolve(dir,'nginx.conf'),'-g','daemon off;'],{stdio:['ignore',nginxFd,nginxFd]});closeSync(nginxFd);
  await until(async()=>{if(nginx.exitCode!==null)throw new Error('nginx startup failed');try{return(await fetch(origins.gateway+'/api/appointments')).status===401;}catch{return false;}},'nginx');
  const workerBase={JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_KEY_ID:'',JWT_ISSUER:'',JWT_AUDIENCE:'',REDIS_URL:'',RATE_LIMIT_KEY_SECRET:'',OBSERVABILITY_TOKEN:''};
  await child('core-outbox',CORE_LAYOUTS[coreLayout].notification,{...workerBase,DATABASE_URL:context.urls.core});
  await child('clinic-worker','services/clinic/dist/worker.js',{...workerBase,DATABASE_URL:context.urls.clinic,CORE_DIRECTORY_TOKEN:credentials.CORE_DIRECTORY_TOKEN});
  // One worker is `notification-worker`, two are `notification-worker-0/1` (each its own log, application_name and instance id, as Core's and Clinic's instances); pause and resume act on all of them.
  const notificationWorker=i=>{const name=notificationWorkers===1?'notification-worker':'notification-worker-'+i;return child(name,'services/notification/dist/worker.js',{...workerBase,DATABASE_URL:context.urls.notification,SERVICE_INSTANCE_ID:'p8-'+name});};
  const startNotificationWorkers=async()=>{const started=[];for(let i=0;i<notificationWorkers;i++)started.push(await notificationWorker(i));return started;};
  let consumers=await startNotificationWorkers();
  await child('billing-worker',CORE_LAYOUTS[coreLayout].billing,{...credentials,JWT_PRIVATE_KEY:privateKey,DATABASE_URL:context.urls.core});
  dump('ready.json',{run:context.run,cqrs,password,accounts:dataset.accounts,admin:{id:admin.id,username:admin.username},dataset:dataset.description,baseUrl:origins.gateway,metrics,metricsToken:common.OBSERVABILITY_TOKEN,processes:handles.map(h=>({name:h.name,pid:h.child.pid})),clinicReplicas:context.replicas,coreReplicas,
    // The process layout of the member: Clinic API instances (clinic-0, clinic-1), Notification workers on the one queue, and the single Clinic worker (relay and consumer), which no configuration multiplies.
    clinicInstances:handles.filter(h=>/^clinic-\d+$/.test(h.name)).map(h=>h.name),notificationWorkers,clinicWorkers:1,
    // direct: /api/notifications goes straight to Notification as in deploy/phase2/nginx.split.conf.example; core-ingress and the Kaggle bridge v1 harness send it through Core.
    gateway:{topology:gatewayTopology,notificationsRoute:gatewayTopology==='direct'?'direct-to-notification':'through-core',coreLayout,dbPoolLimit,coreUpstream:coreProxy?'Clinic and Notification reach Core through nginx upstream core_internal (keepalive 16); gateway through upstream core':'one Core, called directly',coreInstances:handles.filter(h=>/^core(-\d+)?$/.test(h.name)).map(h=>h.name),
      clinicUpstream:{servers:clinicPorts.length,maxFails:coreProxy?0:null,proxyNextUpstream:coreProxy?'off':'error timeout http_502 http_503 http_504'}},dbCrossConnectDenied:6});
  const lines=createInterface({input:process.stdin});
  for await(const line of lines){
    const command=JSON.parse(line);
    if(command.action==='stop')break;
    assert.match(command.id,/^[0-9a-f-]{36}$/);
    let response;
    try{
      if(command.action==='cqrs-observe'){assert.ok(cqrsTools);response={...await cqrsTools.observeReadModel(db.clinic,cqrsMode),unexpectedExit:failed};}
      else if(command.action==='cqrs-query-plans'){
        assert.equal(profile,'query-heavy');assert.equal(cqrsMode,'B');
        const {collectQueryPlans}=await import('./cqrs_query_plans.mjs');
        response=await collectQueryPlans(db.clinic,context.urls.clinic,context);
      }
      else if(command.action==='pause-notification'){for(const worker of consumers)await stop(worker);response={paused:true};}
      else if(command.action==='resume-notification'){assert.ok(consumers.every(worker=>worker.child.exitCode!==null||worker.child.signalCode!==null),'resume-notification while a worker runs');consumers=await startNotificationWorkers();response={resumed:true};}
      else if(command.action==='query-snapshot'||command.action==='query-observe'){
        assert.equal(profile,'query-heavy');
        const {querySnapshot,queryObserve}=await import('./query_dataset.mjs');
        response=command.action==='query-snapshot'?await querySnapshot(db.clinic):await queryObserve(db.clinic);
        response.unexpectedExit=failed;
      }
      else if(command.action==='inspect'){
        const ids=command.appointmentIds;
        if(ids!==undefined)assert.ok(Array.isArray(ids)&&ids.length>0&&ids.length<=300&&ids.every(id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id)));
        const appointments=await db.clinic.appointment.findMany({where:ids?{id:{in:ids}}:undefined,select:{id:true,ownerId:true,petId:true,type:true,appointmentDate:true,appointmentTime:true,status:true,statusRevision:true}});
        const notifications=await db.notification.notification.findMany({where:{relatedAppointmentId:ids?{in:ids}:{not:null}},select:{id:true,relatedAppointmentId:true,recipientRole:true,recipientOwnerId:true}});
        const invoices=await db.core.invoice.findMany({where:{appointmentId:ids?{in:ids}:{not:null}},select:{id:true,appointmentId:true}});
        const reservations=await db.clinic.appointmentReservation.findMany({where:ids?{appointmentId:{in:ids}}:undefined,select:{appointmentId:true,state:true,invoiceId:true}});
        response={appointments,notifications,invoices,reservations,pendingCore:await db.core.outboxEvent.count({where:{publishedAt:null}}),pendingClinic:await db.clinic.outboxEvent.count({where:{publishedAt:null}}),unexpectedExit:failed};
      }else throw new Error('unknown-action');
      dump(command.id+'.json',response);
    }catch{dump(command.id+'.json',{error:'control-action-failed'});}
  }
}catch(error){
  dump('failure.json',{name:error?.name??'Error',message:error?.message??'Unknown error',stack:error?.stack??''});
  failed=true;process.stderr.write('KAGGLE_STACK_FAILED: inspect private setup/application logs; credentials suppressed\n');
}finally{await cleanup();process.stdin.pause();}
process.exitCode=failed?1:0;
