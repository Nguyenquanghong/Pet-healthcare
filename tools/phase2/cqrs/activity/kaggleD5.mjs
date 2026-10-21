// D5 Kaggle readiness controller (shared envelope). Runs ONLY inside the guarded
// private trial built by benchmarks/phase2/kaggle/activity_d5_native.py:
// identity/grants checks, 100k fixture, V2 rebuild, full process composition
// (Core/Clinic/Notification APIs, workers, relay, V2 read worker, Nginx), PID/role
// ledger + CPU collector, generator calibration and S/C/P smoke via the gateway.
// No acceptance timing: policy performanceMeasurementsAllowed=false.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,mkdirSync,openSync,closeSync,existsSync,readdirSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {randomUUID,generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {PrismaClient as Core} from '@prisma/client';
import {PrismaClient as Clinic} from '../../../../services/clinic/src/generated/client/index.js';
import {PrismaClient as Notification} from '../../../../services/notification/src/generated/client/index.js';
import {hashPasswordAsync} from '../../../../backend/dist/src/lib/password.js';
import {initializeAppointmentProjection} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentRebuild} from '../../../../services/clinic/dist/readRebuild.js';
import {reconcileProjection} from '../../../../services/clinic/dist/projectionSnapshot.js';
import {summaryDrift} from '../../../../services/clinic/dist/clinicActivitySummary.js';
import {runtimeGrantStatements} from '../../p7-cutover.mjs';
import {buildActivityFixture} from './fixture.mjs';
import {productPlan} from './bench/generator.mjs';
import {classify} from './bench/evaluator.mjs';
import {startCollector,windowCpu} from './bench/collector.mjs';

const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.equal(process.platform,'linux');assert.equal(c.kind,'clinic-activity-d5-native-v1');
assert.match(c.run,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const dir=realpathSync(c.directory);assert.equal(dir,'/tmp/clinic-activity-d5-'+c.run);assert.equal(dirname(realpathSync(process.argv[2])),dir);
assert.equal(realpathSync(c.pgData),dir+'/pgdata');const reports=resolve(dir,'reports');mkdirSync(reports,{recursive:true,mode:0o700});
for(const f of ['.env','backend/.env','services/clinic/.env','services/notification/.env'])assert.equal(existsSync(f),false,'Remove private env: '+f);
const cleanEnv=Object.fromEntries(['PATH','HOME','LANG','TMPDIR'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const save=(name,value)=>writeFileSync(resolve(reports,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const sha=v=>createHash('sha256').update(v).digest('hex'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(200);}throw new Error('TIMEOUT_'+label);}
async function port(){const s=createServer().listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const stage=s=>process.stdout.write(JSON.stringify({d5stage:s,at:new Date().toISOString()})+'\n');
const readiness={kind:'CLINIC_ACTIVITY_D5_READINESS_NOT_ACCEPTANCE',run:c.run,policy:'v9 partial: fullyFrozen=false, performanceMeasurementsAllowed=false',checks:{}};
const check=(name,status,detail={})=>{readiness.checks[name]={status,...detail};save('readiness.json',readiness);};

const Clients={core:Core,clinic:Clinic,notification:Notification},op={},handles=[];let nginx,collector,failed=false;
async function identity(name,url){
  const client=new Clients[name]({datasourceUrl:url});
  try{const [r]=await client.$queryRaw`SELECT current_database() AS db,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
      (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) AS "dbMarker",(SELECT obj_description(oid,'pg_namespace') FROM pg_namespace WHERE nspname=current_schema()) AS "schemaMarker",current_schema() AS schema`;
    assert.equal(r.superuser,false);assert.equal(r.dbMarker,c.marker);assert.equal(r.schemaMarker,c.marker);assert.equal(r.schema,c.schema);return r;}
  finally{await client.$disconnect();}
}
async function stop(h){if(h.child.exitCode!==null)return;h.expected=true;h.child.send?.({type:'shutdown'});try{await until(()=>h.child.exitCode!==null,'stop_'+h.name,15000);}catch{h.child.kill('SIGKILL');failed=true;}}
async function cleanup(){collector?.stop();if(nginx&&nginx.exitCode===null){nginx.kill('SIGQUIT');await until(()=>nginx.exitCode!==null,'nginx',5000).catch(()=>nginx.kill('SIGKILL'));}
  for(const h of [...handles].reverse())await stop(h).catch(()=>{});await Promise.allSettled(Object.values(op).map(x=>x.$disconnect()));}
try{
  stage('identity-and-grants');
  const ids=[];for(const [name,urls] of Object.entries(c.urls))for(const [access,url] of Object.entries(urls))ids.push({component:name,access,...await identity(name,url)});
  for(const name of Object.keys(c.urls))op[name]=new Clients[name]({datasourceUrl:c.urls[name].operator});
  const runtimeRoles={core:[c.roles.core],clinic:[c.roles.clinic,c.roles.projector],notification:[c.roles.notification]};
  for(const [kind,roles] of Object.entries(runtimeRoles))for(const role of roles)for(const s of runtimeGrantStatements(kind,`"${role}"`,true,`"${c.schema}"`))await op[kind].$executeRawUnsafe(s);
  const can=async(kind,role,table,priv)=>(await op[kind].$queryRawUnsafe(`SELECT has_table_privilege($1,'"${c.schema}"."${table}"',$2) AS ok`,role,priv))[0].ok;
  const matrix=[];for(const [role,table,priv,expected] of [[c.roles.clinic,'AppointmentDailySummary','DELETE',false],[c.roles.clinic,'ClinicActivityControl','UPDATE',false],
    [c.roles.clinic,'ReadProjectionGeneration','UPDATE',false],[c.roles.projector,'AppointmentDailySummary','INSERT',true],[c.roles.projector,'AppointmentDailySummary','UPDATE',true],
    [c.roles.projector,'ClinicActivityControl','SELECT',true],[c.roles.clinic,'appointments','UPDATE',true]]){const ok=await can('clinic',role,table,priv);matrix.push({role,table,priv,actual:ok,expected});assert.equal(ok,expected,role+table+priv);}
  check('identity',ids.every(r=>r.superuser===false)?'PASS':'FAIL',{identities:ids.map(({component,access,db,role,superuser})=>({component,access,db,role,superuser}))});
  check('grants','PASS',{source:'tools/phase2/p7-cutover.mjs runtimeGrantStatements',matrix});

  stage('seed-100k-and-rebuild-v2');
  const fixture=buildActivityFixture({rows:c.fixtureRows,seed:c.seed,businessDate:c.businessDate});
  const login={username:'d5admin',password:randomBytes(24).toString('hex')},hash=await hashPasswordAsync(login.password),adminId=randomUUID();
  assert.equal(await op.core.user.count(),0);assert.equal(await op.clinic.appointment.count(),0);
  await op.core.user.createMany({data:[...fixture.owners.map(o=>({id:o.id,role:'owner',fullName:o.fullName,...hash})),{id:adminId,role:'admin',fullName:'D5 admin',username:login.username,...hash}]});
  await op.core.pet.createMany({data:fixture.pets.map(p=>({...p,allergies:[]}))});
  for(let i=0;i<fixture.appointments.length;i+=2500)await op.clinic.appointment.createMany({data:fixture.appointments.slice(i,i+2500).map(a=>({...a,appointmentDate:new Date(a.appointmentDate+'T00:00:00Z'),createdAt:new Date(a.createdAt),updatedAt:new Date(a.updatedAt)}))});
  assert.equal(await op.clinic.appointment.count(),c.fixtureRows);
  await initializeAppointmentProjection(op.clinic,randomUUID());
  const single=new URL(c.urls.clinic.operator);single.searchParams.set('connection_limit','1');const opOne=new Clinic({datasourceUrl:single.href}),engine=new AppointmentRebuild(opOne);
  const generation=randomUUID(),rebuildRun=randomUUID(),t0=Date.now();
  try{await engine.claim(rebuildRun,generation,{schemaVersion:2});while(!(await engine.batch(rebuildRun,2000)).done){}await engine.summarize(rebuildRun);await engine.verify(rebuildRun);await engine.activate(rebuildRun);}finally{await engine.close();await opOne.$disconnect();}
  // Runbook step (D3 risk): fresh statistics after the bulk load/rebuild, so the first
  // evidence audits are not judged on missing stats. Operator owns the tables; budgets unchanged.
  const t1=Date.now();await op.clinic.$executeRawUnsafe('ANALYZE appointments, "ClinicReadRevision", "AppointmentReadRow", "AppointmentDailySummary"');
  check('fixture-and-rebuild','PASS',{fixture:fixture.manifest,generation,rebuildFreezeMs:t1-t0,analyzeAfterRebuildMs:Date.now()-t1});

  stage('start-full-composition');
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),secret=()=>randomBytes(32).toString('hex');
  const credentials=Object.fromEntries(['CORE_DIRECTORY_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_NOTIFICATION_SEND_TOKEN'].map(k=>[k,secret()]));
  const ports={core:await port(),notification:await port(),clinic:await port(),clinicApp:await port(),gateway:await port()},origins=Object.fromEntries(Object.entries(ports).map(([k,v])=>[k,'http://127.0.0.1:'+v]));
  const common={HOST:'127.0.0.1',PHASE2_RUNTIME_REQUIRED:'1',JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_KEY_ID:'d5-kaggle',JWT_ISSUER:'d5-core',JWT_AUDIENCE:'pet-healthcare',JWT_SECRET:'',
    REDIS_URL:c.redis,RATE_LIMIT_NAMESPACE:'d5-'+c.run,RATE_LIMIT_KEY_SECRET:secret(),OBSERVABILITY_TOKEN:secret(),DB_POOL_LIMIT:'4',HASH_CONCURRENCY:'2',HASH_PENDING_LIMIT:'16',TRUST_PROXY_CIDRS:'',
    BROKER_URL:c.broker,BROKER_PREFIX:'d5.'+c.run,PAYMENTS_DEMO:'1',VNPAY_ENABLED:'false',BANK_TRANSFER_ENABLED:'false',CORS_ORIGIN:'',CORE_SERVICE_URL:origins.core,CLINIC_SERVICE_URL:origins.clinic,NOTIFICATION_SERVICE_URL:origins.notification};
  async function child(name,file,extra,readyPort){
    const fd=openSync(resolve(dir,name+'.log'),'a',0o600);const p=spawn(process.execPath,[file],{env:{...cleanEnv,...common,...extra},stdio:['ignore',fd,fd,'ipc']});closeSync(fd);
    const h={name,child:p,expected:false};handles.push(h);p.once('exit',code=>{if(!h.expected){failed=true;save('unexpected-exit.json',{name,code});}});
    await until(async()=>{if(p.exitCode!==null)throw new Error('CHILD_STARTUP_FAILED_'+name);
      if(readyPort){try{return(await fetch('http://127.0.0.1:'+readyPort+'/health/ready')).status===200;}catch{return false;}}
      return readFileSync(resolve(dir,name+'.log'),'utf8').includes('worker-ready');},name,120000);return h;}
  const workerBase={JWT_PRIVATE_KEY:'',JWT_PUBLIC_KEY:'',JWT_KEY_ID:'',JWT_ISSUER:'',JWT_AUDIENCE:'',REDIS_URL:'',RATE_LIMIT_KEY_SECRET:'',OBSERVABILITY_TOKEN:''};
  const readWorker=await child('clinic-read-worker','services/clinic/dist/readWorker.js',{...workerBase,DATABASE_URL:c.urls.clinic.projector,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1'});
  const coreApi=await child('core','backend/dist/src/index.js',{...credentials,JWT_PRIVATE_KEY:privateKey,DATABASE_URL:c.urls.core.api,PORT:String(ports.core),SERVICE_INSTANCE_ID:'d5-core'},ports.core);
  const clinicApi=await child('clinic-0','services/clinic/dist/index.js',{...credentials,CORE_NOTIFICATION_SEND_TOKEN:'',DATABASE_URL:c.urls.clinic.api,PORT:String(ports.clinicApp),SERVICE_INSTANCE_ID:'d5-clinic-0',
    CLINIC_READ_MODE:'authoritative',CLINIC_ACTIVITY_MODE:'control',CLINIC_ACTIVITY_SUMMARY_EVIDENCE:'1',CLINIC_READ_DIAGNOSTICS:'0'},ports.clinicApp);
  const notificationApi=await child('notification','services/notification/dist/index.js',{CORE_NOTIFICATION_SEND_TOKEN:credentials.CORE_NOTIFICATION_SEND_TOKEN,DATABASE_URL:c.urls.notification.api,PORT:String(ports.notification)},ports.notification);
  mkdirSync(resolve(dir,'nginx-temp'));
  const hdr='proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Request-ID $request_id; proxy_connect_timeout 1s; proxy_read_timeout 15s; proxy_next_upstream error timeout http_502 http_503 http_504;';
  writeFileSync(resolve(dir,'nginx.conf'),`pid ${dir}/nginx.pid; error_log ${dir}/nginx.log; events { worker_connections 1024; } http { access_log off; client_body_temp_path ${dir}/nginx-temp; proxy_temp_path ${dir}/nginx-temp; upstream clinic { server 127.0.0.1:${ports.clinicApp}; } server { listen 127.0.0.1:${ports.clinic}; location / { ${hdr} proxy_pass http://clinic; } } server { listen 127.0.0.1:${ports.gateway}; location ~ ^/(internal|metrics|health) { return 404; } location ~ ^/api/(appointments|medical-records)(/|$) { ${hdr} proxy_pass http://clinic; } location /api/ { ${hdr} proxy_pass ${origins.core}; } location / { return 404; } } }`);
  const nfd=openSync(resolve(dir,'nginx-console.log'),'a',0o600);nginx=spawn('nginx',['-p',dir+'/','-c',resolve(dir,'nginx.conf'),'-g','daemon off;'],{stdio:['ignore',nfd,nfd]});closeSync(nfd);
  await until(async()=>{if(nginx.exitCode!==null)throw new Error('NGINX_STARTUP_FAILED');try{return(await fetch(origins.gateway+'/api/appointments')).status===401;}catch{return false;}},'nginx');
  const coreOutbox=await child('core-outbox','backend/dist/src/phase2/notificationWorker.js',{...workerBase,DATABASE_URL:c.urls.core.api});
  const clinicWorker=await child('clinic-worker','services/clinic/dist/worker.js',{...workerBase,DATABASE_URL:c.urls.clinic.api,CORE_DIRECTORY_TOKEN:credentials.CORE_DIRECTORY_TOKEN});
  const notificationWorker=await child('notification-worker','services/notification/dist/worker.js',{...workerBase,DATABASE_URL:c.urls.notification.api});
  const billingWorker=await child('billing-worker','backend/dist/src/phase2/billingWorker.js',{...credentials,JWT_PRIVATE_KEY:privateKey,DATABASE_URL:c.urls.core.api});
  const ready=readFileSync(resolve(dir,'clinic-0.log'),'utf8').split('\n').find(l=>l.includes('api-ready'));
  check('composition','PASS',{clinicApiReady:JSON.parse(ready),readWorkerReady:JSON.parse(readFileSync(resolve(dir,'clinic-read-worker.log'),'utf8').split('\n').find(l=>l.includes('worker-ready'))),
    processes:handles.map(h=>({name:h.name,pid:h.child.pid})).concat([{name:'nginx',pid:nginx.pid}]),gateway:'nginx -> /api/appointments|medical-records Clinic, /api/* Core (activity via Core proxy)'});

  stage('ledger-and-collector');
  const pgPid=Number(readFileSync(c.pgData+'/postmaster.pid','utf8').split('\n')[0]);
  const ledger={api:[coreApi.child.pid,clinicApi.child.pid,notificationApi.child.pid],worker:[readWorker.child.pid,coreOutbox.child.pid,notificationWorker.child.pid,billingWorker.child.pid],
    relay:[clinicWorker.child.pid],postgres:[pgPid],broker:[c.pids.broker],redis:[c.pids.redis],gateway:[nginx.pid],controller:[process.pid],generator:[]};
  const clockTicks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim()),resourceFile=resolve(reports,'resource-raw.jsonl');
  collector=startCollector(ledger,resourceFile,{intervalMs:1000,clockTicks});
  const expectedRoles=['api','worker','relay','postgres','broker','redis','gateway','controller','generator'];
  const samples=()=>readFileSync(resourceFile,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const poolPeaks={};const poolTimer=setInterval(async()=>{try{for(const kind of ['core','clinic','notification']){const rows=await op[kind].$queryRaw`SELECT usename AS role,count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename IS NOT NULL GROUP BY 1`;
    for(const r of rows){const k=kind+':'+r.role;poolPeaks[k]=Math.max(poolPeaks[k]??0,r.n);}}}catch{}},1000);poolTimer.unref();

  const login1=await fetch(origins.gateway+'/api/auth/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(login)});
  assert.equal(login1.status,200,'ADMIN_LOGIN_THROUGH_GATEWAY');const token=(await login1.json()).token;
  const scenarios=[{name:'primary30day',q:'from=2030-09-21&to=2030-10-20'},{name:'12month',q:'from=2029-11-01&to=2030-10-20&groupBy=month'},
    {name:'clinic',q:'from=2030-09-21&to=2030-10-20&category=clinic'},{name:'spa',q:'from=2030-09-21&to=2030-10-20&category=spa'},{name:'zero',q:'from=2040-01-01&to=2040-01-30'}];
  const rawFile=resolve(reports,'request-raw.jsonl'),traces=[];
  async function generate(label,kind,plan,baseUrl,extra={}){
    const spec={run:c.run,directory:dir,kind,label,plan,baseUrl,token,scenarios,rawFile,resultFile:resolve(dir,'gen-'+label+'.json'),...extra},file=resolve(dir,'gen-'+label+'-spec.json');
    writeFileSync(file,JSON.stringify(spec),{mode:0o600});traces.push({label,kind,plan});
    const fd=openSync(resolve(dir,'generator-'+label+'.log'),'a',0o600);const g=spawn(process.execPath,['tools/phase2/cqrs/activity/kaggleD5Generator.mjs',file],{env:cleanEnv,stdio:['ignore',fd,fd]});closeSync(fd);
    ledger.generator=[g.pid];await new Promise(r=>g.once('exit',r));ledger.generator=[];assert.equal(g.exitCode,0,'GENERATOR_FAILED_'+label);
    const result=JSON.parse(readFileSync(spec.resultFile,'utf8')),start=result.originWallMs+plan.warmupMs,end=start+plan.measuredMs;
    return {...result,cpu:windowCpu(samples(),start,end,expectedRoles)};
  }

  stage('generator-calibration-2x-noop');
  const sinkPort=await port(),sink=spawn(process.execPath,['-e',`require('http').createServer((q,s)=>{s.writeHead(204);s.end();}).listen(${sinkPort},'127.0.0.1')`],{env:cleanEnv,stdio:'ignore'});
  await until(async()=>{try{return(await fetch('http://127.0.0.1:'+sinkPort+'/noop')).status===204;}catch{return false;}},'sink');
  ledger.controller=[process.pid,sink.pid];
  // Locked: 120 s open loop at 2x the planned product arrival rate, collector running.
  const calibration=await generate('calibration','calibration',{screens:20,pollMs:15000,warmupMs:0,measuredMs:120000,writesPerSecond:0.2,seed:20261020},'http://127.0.0.1:'+sinkPort);
  sink.kill('SIGTERM');ledger.controller=[process.pid];
  check('generator-calibration',calibration.validity.valid?'PASS':'FAIL',calibration);

  stage('smoke-scp-100k-through-gateway');
  const candidates=await op.clinic.appointment.findMany({where:{status:'pending'},select:{id:true,statusRevision:true},orderBy:{id:'asc'},take:600});
  const smoke=[];let used=0;
  for(const [label,mode] of [['S','source'],['C','cached'],['P','summary']]){
    await op.clinic.clinicActivityControl.update({where:{id:1},data:{servingMode:mode}});await delay(4000);
    const plan={screens:10,pollMs:3000,warmupMs:15000,measuredMs:75000,writesPerSecond:0.5,seed:20261020};
    const r=await generate('smoke-'+label,'smoke',plan,origins.gateway,{writeCandidates:candidates.slice(used,used+60)});used+=60;
    const records=readFileSync(rawFile,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(x=>x.label==='smoke-'+label);
    const run={label,expectedGeneration:generation,simpleReader:mode==='cached'?'C':'S'},counts={};
    for(const rec of records.filter(x=>x.measured)){const k=classify(run,rec).code;counts[k]=(counts[k]??0)+1;}
    const headerMismatch=records.filter(x=>x.kind==='read'&&x.outcome.status===200&&(x.outcome.header?.source!==x.outcome.source||(x.outcome.header?.generation??null)!==(x.outcome.generation??null))).length;
    smoke.push({label,mode,counts,headerMismatch,validity:r.validity,cpuCoverage:{complete:r.cpu.complete,reasons:r.cpu.reasons,applicationCpuSeconds:r.cpu.applicationCpuSeconds,separate:r.cpu.separateCpuSeconds,totalEnvelopeCpuSeconds:r.cpu.totalEnvelopeCpuSeconds}});
    save('smoke.json',{scope:'FUNCTIONAL_SMOKE_NOT_TIMING',generation,smoke});
  }
  await op.clinic.clinicActivityControl.update({where:{id:1},data:{servingMode:'source'}});
  await until(async()=>{const rows=await op.clinic.$transaction(tx=>reconcileProjection(tx,generation),{timeout:60000});if(Object.values(rows).some(n=>n))return false;
    const d=await op.clinic.$transaction(tx=>summaryDrift(tx,generation,{source:true}),{timeout:60000});return d.rows===0&&d.source===0;},'catch_up',180000);
  // HTTP business parity summary vs source through the gateway after quiesce.
  const read=async q=>{const r=await fetch(origins.gateway+'/api/dashboard/clinic/activity?'+q,{headers:{Authorization:'Bearer '+token}});const {meta,...b}=await r.json();return {meta,b};};
  const sourceViews={};for(const sc of scenarios)sourceViews[sc.name]=await read(sc.q);
  await op.clinic.clinicActivityControl.update({where:{id:1},data:{servingMode:'summary'}});await delay(4000);
  const parity=[];for(const sc of scenarios){const p=await read(sc.q);parity.push({scenario:sc.name,source:p.meta.source,equal:JSON.stringify(p.b)===JSON.stringify(sourceViews[sc.name].b)});}
  await op.clinic.clinicActivityControl.update({where:{id:1},data:{servingMode:'source'}});
  const smokeOk=smoke.every(s=>Object.keys(s.counts).join()==='success'&&s.headerMismatch===0&&s.validity.valid)&&parity.every(p=>p.equal&&p.source==='summary');
  check('smoke',smokeOk?'PASS':'FAIL',{smoke,parity,correctness:{sourceToReadRowMismatch:0,readRowToSummaryMismatch:0}});
  check('cpu-coverage',smoke.every(s=>s.cpuCoverage.complete)?'PASS':'INCOMPLETE',{expectedRoles,auditRunsInside:'api (Clinic API process)',relayRunsInside:'relay (Clinic worker)'});
  clearInterval(poolTimer);

  stage('profile-and-hashes');
  // Some tools (nginx -v) print the version on stderr.
  const version=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});return ((r.stdout||'')+(r.stderr||'')).trim().split('\n')[0]||'unavailable';};
  const tree=root=>existsSync(root)?readdirSync(root).flatMap(n=>{const p=root+'/'+n;return statSync(p).isDirectory()?tree(p):[p];}):[];
  const hashList=paths=>sha(JSON.stringify(paths.sort().map(p=>[p,sha(readFileSync(p))])));
  const harness=['tools/phase2/cqrs/activity/kaggleD5.mjs','tools/phase2/cqrs/activity/kaggleD5Generator.mjs',...tree('tools/phase2/cqrs/activity/bench')];
  const versions={node:process.version,npm:version('npm',['--version']),prisma:JSON.parse(readFileSync('node_modules/prisma/package.json','utf8')).version,
    postgres:(await op.clinic.$queryRaw`SHOW server_version`)[0].server_version,redis:version('redis-server',['--version']),nginx:version('nginx',['-v']),
    rabbitmq:version('dpkg-query',['-W','-f=${Version}','rabbitmq-server']),erlang:version('dpkg-query',['-W','-f=${Version}','erlang-base']),kernel:version('uname',['-r'])};
  const policyBytes=readFileSync('phase2-plan/cqrs/clinic-activity/acceptance.frozen.json');
  const hashes={sourceArchiveSha256:c.sourceArchiveSha256,sourceTreeSha256:c.sourceTreeSha256,buildSha256:hashList(['backend/dist','services/clinic/dist','services/notification/dist','packages/runtime/dist','packages/contracts/dist','packages/messaging/dist'].flatMap(tree)),
    fixtureSha256:fixture.manifest.contentSha256,traceSha256:sha(JSON.stringify(traces)),harnessSha256:hashList(harness),policySha256:sha(policyBytes),migrationSha256:hashList(tree('services/clinic/prisma/migrations'))};
  const poolLimits={coreApi:4,clinicApi:4,clinicAudit:1,readWorker:1,notificationApi:4,operator:'per client',source:'DB_POOL_LIMIT/connection_limit as configured'};
  const profileKey={resourceClass:'kaggle_shared_envelope',cpuModel:c.envProfile.cpuModel,architecture:c.envProfile.architecture,cpuQuotaAndAffinity:{quota:c.envProfile.cpuMax,affinity:c.envProfile.affinity},
    memoryMax:c.envProfile.memoryMax,liveSoftwareVersions:versions,replicas:{clinic:1,core:1,notification:1},poolLimits,sourceBuildManifests:{source:hashes.sourceTreeSha256,build:hashes.buildSha256},
    logicalFixtureDigest:hashes.fixtureSha256,traceDigest:hashes.traceSha256,harnessDigest:hashes.harnessSha256,policyDigest:hashes.policySha256};
  save('fresh-profile-and-pid-role-pool-ledger.json',{environment:c.envProfile,versions,ledger:Object.fromEntries(Object.entries(ledger).filter(([k])=>k!=='generator')),poolLimits,poolPeaks,
    accounting:'role CPU = /proc utime+stime incl. descendants; generator/controller separate; root cgroup total separate; no isolation claimed',profileKey});
  save('plan-and-hashes.json',{hashes,profileKey,profileKeySha256:sha(JSON.stringify(profileKey)),traces});
  check('profile','PASS',{profileKeySha256:sha(JSON.stringify(profileKey))});
  readiness.status=!failed&&Object.values(readiness.checks).every(x=>x.status==='PASS')?'READY_FOR_POLICY_FREEZE_REVIEW':'NOT_READY';save('readiness.json',readiness);
}catch(error){failed=true;readiness.status='FAILED';readiness.error={name:error?.name??'Error',message:String(error?.message??'').replace(/postgresql:\/\/[^\s'"]+|amqp:\/\/[^\s'"]+|redis:\/\/[^\s'"]+/g,'<redacted>').slice(0,400)};save('readiness.json',readiness);}
finally{await cleanup();}
process.exitCode=failed?1:0;
