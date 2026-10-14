// Dedicated native Kaggle fixture. Does not modify the Compose/E2E guards.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,mkdirSync,openSync,closeSync,renameSync} from 'node:fs';
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
  assert.ok(['deep','pcn'].includes(profile));
  const makeDataset=profile==='pcn'?(await import('./pcn_dataset.mjs')).createPcnDataset:createDataset;
  const dataset=await makeDataset(db,{run:context.run,hash,count:context.accounts,anchor:new Date()});
  const admin=await db.core.user.create({data:{id:randomUUID(),username:'p8_'+context.run,fullName:'Synthetic benchmark admin',role:'admin',...hash}});
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const secret=()=>randomBytes(32).toString('hex');
  const credentials=Object.fromEntries(['CORE_DIRECTORY_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_NOTIFICATION_SEND_TOKEN'].map(k=>[k,secret()]));
  const common={HOST:'127.0.0.1',PHASE2_RUNTIME_REQUIRED:'1',JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_KEY_ID:'p8-kaggle',JWT_ISSUER:'p8-core',JWT_AUDIENCE:'pet-healthcare',JWT_SECRET:'',REDIS_URL:context.redis,RATE_LIMIT_NAMESPACE:'p8-'+context.run,RATE_LIMIT_KEY_SECRET:secret(),OBSERVABILITY_TOKEN:secret(),DB_POOL_LIMIT:'4',HASH_CONCURRENCY:'2',HASH_PENDING_LIMIT:'16',TRUST_PROXY_CIDRS:'',BROKER_URL:context.broker,BROKER_PREFIX:'p8.'+context.run,PAYMENTS_DEMO:'1',VNPAY_ENABLED:'false',BANK_TRANSFER_ENABLED:'false',CORS_ORIGIN:''};
  const ports={core:await port(),notification:await port(),clinic:await port(),gateway:await port()};
  const clinicPorts=[];for(let n=0;n<context.replicas;n++)clinicPorts.push(await port());
  const origins=Object.fromEntries(Object.entries(ports).map(([k,v])=>[k,'http://127.0.0.1:'+v]));
  common.CORE_SERVICE_URL=origins.core;common.CLINIC_SERVICE_URL=origins.clinic;common.NOTIFICATION_SERVICE_URL=origins.notification;
  const metrics=[];
  async function child(name,file,extra,readyPort){
    const fd=openSync(resolve(dir,name+'.log'),'a',0o600);
    const c=spawn(process.execPath,[file],{env:{...cleanEnv,...common,...extra},stdio:['ignore',fd,fd,'ipc']});closeSync(fd);
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
  await child('core','backend/dist/src/index.js',{...credentials,JWT_PRIVATE_KEY:privateKey,DATABASE_URL:context.urls.core,PORT:String(ports.core),SERVICE_INSTANCE_ID:'p8-core'},ports.core);
  for(let i=0;i<clinicPorts.length;i++)await child('clinic-'+i,'services/clinic/dist/index.js',{...credentials,CORE_NOTIFICATION_SEND_TOKEN:'',DATABASE_URL:context.urls.clinic,PORT:String(clinicPorts[i]),SERVICE_INSTANCE_ID:'p8-clinic-'+i},clinicPorts[i]);
  await child('notification','services/notification/dist/index.js',{CORE_NOTIFICATION_SEND_TOKEN:credentials.CORE_NOTIFICATION_SEND_TOKEN,DATABASE_URL:context.urls.notification,PORT:String(ports.notification)},ports.notification);
  mkdirSync(resolve(dir,'nginx-temp'));
  const headers='proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Request-ID $request_id; proxy_connect_timeout 1s; proxy_read_timeout 15s; proxy_next_upstream error timeout http_502 http_503 http_504;';
  const config=`pid ${dir}/nginx.pid; error_log ${dir}/nginx.log; events { worker_connections 1024; } http { access_log off; client_body_temp_path ${dir}/nginx-temp; proxy_temp_path ${dir}/nginx-temp; upstream clinic { ${clinicPorts.map(p=>'server 127.0.0.1:'+p+';').join(' ')} } server { listen 127.0.0.1:${ports.clinic}; location / { ${headers} proxy_pass http://clinic; } } server { listen 127.0.0.1:${ports.gateway}; location ~ ^/(internal|metrics|health) { return 404; } location ~ ^/api/(appointments|medical-records)(/|$) { ${headers} proxy_pass http://clinic; } location /api/ { ${headers} proxy_pass ${origins.core}; } location / { return 404; } } }`;
  writeFileSync(resolve(dir,'nginx.conf'),config);
  const nginxFd=openSync(resolve(dir,'nginx-console.log'),'a',0o600);
  nginx=spawn('nginx',['-p',dir+'/', '-c',resolve(dir,'nginx.conf'),'-g','daemon off;'],{stdio:['ignore',nginxFd,nginxFd]});closeSync(nginxFd);
  await until(async()=>{if(nginx.exitCode!==null)throw new Error('nginx startup failed');try{return(await fetch(origins.gateway+'/api/appointments')).status===401;}catch{return false;}},'nginx');
  const workerBase={JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_KEY_ID:'',JWT_ISSUER:'',JWT_AUDIENCE:'',REDIS_URL:'',RATE_LIMIT_KEY_SECRET:'',OBSERVABILITY_TOKEN:''};
  await child('core-outbox','backend/dist/src/phase2/notificationWorker.js',{...workerBase,DATABASE_URL:context.urls.core});
  await child('clinic-worker','services/clinic/dist/worker.js',{...workerBase,DATABASE_URL:context.urls.clinic,CORE_DIRECTORY_TOKEN:credentials.CORE_DIRECTORY_TOKEN});
  const notificationWorker=()=>child('notification-worker','services/notification/dist/worker.js',{...workerBase,DATABASE_URL:context.urls.notification});
  let consumer=await notificationWorker();
  await child('billing-worker','backend/dist/src/phase2/billingWorker.js',{...credentials,JWT_PRIVATE_KEY:privateKey,DATABASE_URL:context.urls.core});
  dump('ready.json',{run:context.run,password,accounts:dataset.accounts,admin:{id:admin.id,username:admin.username},dataset:dataset.description,baseUrl:origins.gateway,metrics,metricsToken:common.OBSERVABILITY_TOKEN,processes:handles.map(h=>({name:h.name,pid:h.child.pid})),clinicReplicas:context.replicas,dbCrossConnectDenied:6});
  const lines=createInterface({input:process.stdin});
  for await(const line of lines){
    const command=JSON.parse(line);
    if(command.action==='stop')break;
    assert.match(command.id,/^[0-9a-f-]{36}$/);
    let response;
    try{
      if(command.action==='pause-notification'){await stop(consumer);response={paused:true};}
      else if(command.action==='resume-notification'){consumer=await notificationWorker();response={resumed:true};}
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
