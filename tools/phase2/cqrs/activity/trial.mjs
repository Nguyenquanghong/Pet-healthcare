// Authorized disposable Kaggle functional trial only. No load generator or V2.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {PrismaClient as Core} from '@prisma/client';
import {PrismaClient as Clinic} from '../../../../services/clinic/src/generated/client/index.js';
import {createApp} from '../../../../services/clinic/dist/app.js';
import {CoreDirectory} from '../../../../services/clinic/dist/directory.js';
import {createCoreApp} from '../../../../backend/dist/src/phase2/coreApp.js';
import {signToken,verifyToken} from '../../../../backend/dist/src/lib/token.js';
import {hashPasswordAsync} from '../../../../backend/dist/src/lib/password.js';
import {parseActivityFilter,buildActivityBusiness} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {buildActivityFixture} from './fixture.mjs';
import {validateTrialContext,trialUrl,verifyPrivateContextPath,guardDatabase} from './trialGuards.mjs';
import {verifyWarmCacheRoleRevocation,explainActivityStatement} from './trialCoverage.mjs';
import {startTrialFrontend,verifyGatewayBrowser} from './trialBrowser.mjs';

if(process.argv[2]==='--help'){
  console.log('Kaggle D1 trial: --context <private/context.json> --action identity|seed|plans|http. Requires a newly created UUID-marked cluster and explicit authorizedTrialSetup=true. Plans use read-only EXPLAIN without ANALYZE; HTTP includes real gateway browser. No benchmark.');process.exit(0);
}
assert.equal(process.platform,'linux');assert.deepEqual(process.argv.slice(2,3),['--context']);assert.equal(process.argv[4],'--action');assert.equal(process.argv.length,6);
const file=resolve(process.argv[3]),c=JSON.parse(readFileSync(file,'utf8')),action=process.argv[5];
const hex=validateTrialContext(c);verifyPrivateContextPath(c,file);assert.ok(['identity','seed','plans','http'].includes(action));
assert.equal(realpathSync(process.cwd()),c.directory+'/source');
// No inherited application targets or dotenv. The Python launcher supplies only
// PATH/HOME/LANG/TMPDIR; every datasource below comes from the guarded context.
for(const path of ['.env','backend/.env','services/clinic/.env']){
  try{readFileSync(path);throw new Error('UNEXPECTED_DOTENV');}catch(e){if(e.code!=='ENOENT')throw e;}
}
const core=new Core({datasourceUrl:trialUrl(c,'core').href}),clinic=new Clinic({datasourceUrl:trialUrl(c,'clinic').href});
const reports=resolve(c.directory,'reports');mkdirSync(reports,{recursive:true});
const cleanupTasks=[];
const save=(name,value)=>writeFileSync(resolve(reports,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const fixture=buildActivityFixture({rows:c.fixtureRows,seed:c.seed,businessDate:c.businessDate});
const identities=Object.fromEntries(['admin','owner','staff','doctor'].map(role=>[role,{id:randomUUID(),role,fullName:'Synthetic activity '+role}]));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const expected=raw=>{
  const f=parseActivityFilter(raw),counts=new Map();
  for(const a of fixture.appointments){
    if(a.appointmentDate<f.previousFrom||a.appointmentDate>f.to)continue;
    const spa=a.type.startsWith('spa_');if(f.category==='spa'&&!spa||f.category==='clinic'&&spa)continue;
    const key=[a.appointmentDate,a.type,a.status].join('|');counts.set(key,(counts.get(key)??0n)+1n);
  }
  return buildActivityBusiness(f,[...counts].map(([key,n])=>{const [date,type,status]=key.split('|');return {date,type,status,n};}));
};
async function seed(){
  const profile={kind:'D1_FUNCTIONAL_TRIAL_PROFILE_NOT_ENVIRONMENT_PASS',run:c.run,identities:[],fixture:fixture.manifest,
    benchmark:false,resourceEnforcement:'UNVERIFIED',backgroundWorkers:'NOT_STARTED_FUNCTIONAL_SOURCE_CACHE_ONLY'};
  profile.identities.push(await guardDatabase(core,c,'core'),await guardDatabase(clinic,c,'clinic'));
  assert.equal(await core.user.count(),0);assert.equal(await core.pet.count(),0);assert.equal(await clinic.appointment.count(),0);
  const login={username:'activityadmin',password:randomBytes(32).toString('hex')};
  const hash=await hashPasswordAsync(login.password);
  await guardDatabase(core,c,'core');
  await core.user.createMany({data:[...fixture.owners,...Object.values(identities)].map(u=>({id:u.id,role:u.role,fullName:u.fullName,...hash,...(u.id===identities.admin.id?{username:login.username}:{})}))});
  await core.pet.createMany({data:fixture.pets.map(p=>({...p,allergies:[]}))});
  for(let i=0;i<fixture.appointments.length;i+=250){
    await guardDatabase(clinic,c,'clinic');
    await clinic.appointment.createMany({data:fixture.appointments.slice(i,i+250).map(a=>({...a,
      appointmentDate:new Date(a.appointmentDate+'T00:00:00Z'),createdAt:new Date(a.createdAt),updatedAt:new Date(a.updatedAt)}))});
  }
  assert.equal(await clinic.appointment.count(),10000);assert.equal(await core.pet.count(),fixture.pets.length);
  // Compare every seeded appointment's actual source fields, not just its count.
  for(let i=0;i<fixture.appointments.length;i+=250){
    const rows=await clinic.appointment.findMany({where:{id:{in:fixture.appointments.slice(i,i+250).map(a=>a.id)}}});
    const byId=new Map(rows.map(a=>[a.id,a]));
    for(const a of fixture.appointments.slice(i,i+250)){
      const row=byId.get(a.id);assert.ok(row);
      for(const [key,value] of Object.entries(a))assert.deepEqual(row[key] instanceof Date?row[key].toISOString():row[key],
        key==='appointmentDate'?value+'T00:00:00.000Z':value);
    }
  }
  const pets=await core.pet.findMany({select:{id:true,ownerId:true}});assert.deepEqual(new Map(pets.map(p=>[p.id,p.ownerId])),new Map(fixture.pets.map(p=>[p.id,p.ownerId])));
  writeFileSync(resolve(c.directory,'test-identities.json'),JSON.stringify(identities),{mode:0o600,flag:'wx'});
  writeFileSync(resolve(c.directory,'browser-login.json'),JSON.stringify(login),{mode:0o600,flag:'wx'});
  profile.seededSourceFieldsReconciled=true;profile.status='PASS_IN_SCOPE';save('fixture.json',profile);
}
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function closeServer(server){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}
async function stopChild(child){
  if(child.exitCode!==null)return;
  child.kill('SIGQUIT');await Promise.race([once(child,'exit'),sleep(4000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');throw new Error('GATEWAY_FORCED_STOP');}
  assert.equal(child.exitCode,0);
}
async function snapshotProof(){
  const reader=new Clinic({datasourceUrl:trialUrl(c,'clinic','reader').href});
  cleanupTasks.push(()=>reader.$disconnect());
  const id=fixture.appointments[0].id,original=await clinic.appointment.findUniqueOrThrow({where:{id}});
  try{
    await guardDatabase(reader,c,'clinic','reader');
    await reader.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const [settings]=await tx.$queryRaw`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`;
      assert.deepEqual(settings,{isolation:'repeatable read',readonly:'on'});
      assert.equal((await tx.appointment.findUniqueOrThrow({where:{id}})).internalNote,original.internalNote);
      await guardDatabase(clinic,c,'clinic');
      await clinic.appointment.update({where:{id},data:{internalNote:'Synthetic snapshot probe'}});
      assert.equal((await tx.appointment.findUniqueOrThrow({where:{id}})).internalNote,original.internalNote);
    },{isolationLevel:'RepeatableRead',maxWait:50,timeout:10000});
    assert.equal((await reader.appointment.findUniqueOrThrow({where:{id}})).internalNote,'Synthetic snapshot probe');
    return {status:'PASS',isolation:'repeatable read',readOnly:true,concurrentCommitInvisibleUntilNextSnapshot:true};
  }finally{
    await guardDatabase(clinic,c,'clinic');
    await clinic.appointment.update({where:{id},data:{internalNote:original.internalNote,updatedAt:original.updatedAt}});
    await reader.$disconnect();
  }
}
async function plans(){
  const reader=new Clinic({datasourceUrl:trialUrl(c,'clinic','reader').href});
  const report={kind:'D1_READ_ONLY_EXPLAIN_NOT_ANALYZE',run:c.run,status:'STARTING',fixture:fixture.manifest,
    analyze:false,executesSelect:false,performance:'NOT_RUN',plans:[]};
  try{
    report.identity=await guardDatabase(reader,c,'clinic','reader');
    await reader.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='1500ms'");
      const [settings]=await tx.$queryRaw`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`;
      assert.deepEqual(settings,{isolation:'repeatable read',readonly:'on'});report.snapshot=settings;
      for(const [range,from] of [['day','2030-10-20'],['30days','2030-09-21'],['366days','2029-10-20']])for(const category of ['all','clinic','spa']){
        const filter=parseActivityFilter({from,to:'2030-10-20',category,groupBy:'day'}),sql=explainActivityStatement(filter);
        const rows=await tx.$queryRaw(sql),plan=rows[0]?.['QUERY PLAN'];
        assert.ok(Array.isArray(plan)&&plan.length===1&&plan[0].Plan?.['Node Type']);
        assert.doesNotMatch(JSON.stringify(plan),/"Actual [^"]*"|"Execution Time"/);
        report.plans.push({range,category,from:filter.from,to:filter.to,previousFrom:filter.previousFrom,
          statement:sql.text,parameters:sql.values,plan,status:'PASS'});
      }
    },{isolationLevel:'RepeatableRead',maxWait:50,timeout:20000});
    report.status='PASS_IN_SCOPE';
  }catch(error){report.status='FAIL';report.errorType=error.name;throw error;}
  finally{await reader.$disconnect();save('plans.json',report);}
}
async function http(){
  const users=JSON.parse(readFileSync(resolve(c.directory,'test-identities.json'),'utf8'));
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),credential=randomBytes(32).toString('hex');
  Object.assign(process.env,{JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
    JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_ISSUER:'activity-'+c.run,
    JWT_AUDIENCE:'activity-d1',JWT_KEY_ID:'activity-d1',CLINIC_READ_MODE:'authoritative',PHASE2_RUNTIME_REQUIRED:'0'});
  const tokens=Object.fromEntries(Object.entries(users).map(([role,u])=>[role,signToken(u.id,role)]));
  const report={kind:'D1_BOUNDED_FUNCTIONAL_HTTP_NOT_BENCHMARK',run:c.run,status:'STARTING',cases:[],runtimeIdentities:[],requestCount:0,
    composition:'Real Core/Clinic apps + PostgreSQL + Nginx; runtime background dependencies disabled',benchmark:false};
  const browserReport={kind:'D1_REAL_GATEWAY_BROWSER_NOT_BENCHMARK',run:c.run,status:'STARTING',modes:[],performance:'NOT_RUN',fullDeploymentValidated:false};
  try{
  report.snapshotProof=await snapshotProof();
  for(const mode of ['source','cached']){
    await guardDatabase(core,c,'core');await guardDatabase(clinic,c,'clinic');
    const coreApi=new Core({datasourceUrl:trialUrl(c,'core','api').href}),clinicApi=new Clinic({datasourceUrl:trialUrl(c,'clinic','api').href});
    cleanupTasks.push(()=>coreApi.$disconnect(),()=>clinicApi.$disconnect());
    report.runtimeIdentities.push({mode,core:await guardDatabase(coreApi,c,'core','api'),clinic:await guardDatabase(clinicApi,c,'clinic','api')});
    const [clinicGrants]=await clinicApi.$queryRaw`SELECT has_table_privilege(current_user,'appointments','SELECT') AS select,
      has_table_privilege(current_user,'appointments','INSERT') AS insert,has_table_privilege(current_user,'appointments','UPDATE') AS update,
      has_table_privilege(current_user,'appointments','DELETE') AS delete`;
    assert.deepEqual(clinicGrants,{select:true,insert:false,update:false,delete:false});
    const [coreGrants]=await coreApi.$queryRaw`SELECT has_table_privilege(current_user,'users','SELECT') AS select,has_table_privilege(current_user,'users','UPDATE') AS update`;
    assert.deepEqual(coreGrants,{select:true,update:false});
    report.runtimeIdentities.at(-1).grants={clinicAppointments:clinicGrants,coreUsers:coreGrants};
    process.env.CLINIC_ACTIVITY_MODE=mode;
    let directory;const directoryPort={request:(...args)=>directory.request(...args),acceptsService:()=>false};
    const clinicServer=createApp(clinicApi,verifyToken,directoryPort).listen(0,'127.0.0.1');await once(clinicServer,'listening');
    cleanupTasks.push(()=>closeServer(clinicServer));
    const clinicUrl='http://127.0.0.1:'+clinicServer.address().port;
    const coreServer=createCoreApp(coreApi,{clinicUrl,clinicToken:credential,directoryToken:credential}).listen(0,'127.0.0.1');await once(coreServer,'listening');
    cleanupTasks.push(()=>closeServer(coreServer));
    const coreUrl='http://127.0.0.1:'+coreServer.address().port;directory=new CoreDirectory(coreUrl,credential);
    const frontendServer=await startTrialFrontend(resolve(c.directory,'source/frontend/dist'));
    cleanupTasks.push(()=>closeServer(frontendServer));const frontendUrl='http://127.0.0.1:'+frontendServer.address().port;
    const port=await freePort(),gateway='http://127.0.0.1:'+port,config=resolve(c.directory,'nginx-'+mode+'.conf');
    writeFileSync(config,`worker_processes 1; pid ${c.directory}/nginx-${mode}.pid; error_log ${c.directory}/nginx-${mode}.log;\nevents { worker_connections 64; }\nhttp { access_log off; server { listen 127.0.0.1:${port}; location /api/ { proxy_pass ${coreUrl}; proxy_read_timeout 8s; } location / { proxy_pass ${frontendUrl}; } } }\n`,{mode:0o600});
    const fd=openSync(resolve(c.directory,'nginx-'+mode+'-startup.log'),'a',0o600);
    const nginx=spawn('nginx',['-p',c.directory+'/', '-c',config,'-g','daemon off;'],{stdio:['ignore',fd,fd]});closeSync(fd);
    cleanupTasks.push(async()=>{if(nginx.pid)await stopChild(nginx);});
    let spawnError=false;nginx.on('error',()=>{spawnError=true;});
    const get=async(base,role='admin',query='from=2030-09-21&to=2030-10-20',headers={})=>{
      assert.ok(report.requestCount++<240,'FUNCTIONAL_REQUEST_BUDGET');
      return fetch(base+'/api/dashboard/clinic/activity?'+query,{headers:{...(role?{authorization:'Bearer '+(tokens[role]??'invalid')}:{}),...headers},signal:AbortSignal.timeout(6000),redirect:'error'});
    };
    try{
      let ready=false;
      for(let i=0;i<40;i++){if(spawnError||nginx.exitCode!==null)throw new Error('GATEWAY_START_FAILED');try{const r=await get(gateway,null);if(r.status===401){ready=true;break;}}catch{}await sleep(100);}
      assert.ok(ready,'GATEWAY_READY');
      for(const category of ['all','clinic','spa'])for(const groupBy of ['day','month']){
        const raw={from:'2030-09-21',to:'2030-10-20',category,groupBy},query=new URLSearchParams(raw);
        for(const base of [clinicUrl,gateway]){
          const r=await get(base,'admin',query),body=await r.json();assert.equal(r.status,200);const {meta,...business}=body;
          assert.deepEqual(business,expected(raw));assert.equal(r.headers.get('cache-control'),'no-store');
          assert.equal(r.headers.get('x-clinic-read-source'),meta.source);assert.ok([mode==='source'?'source':'cached','source'].includes(meta.source));
          report.cases.push({mode,operation:'business-parity',entrypoint:base===gateway?'nginx-core-clinic':'direct-clinic',category,groupBy,status:'PASS'});
        }
      }
      for(const base of [clinicUrl,coreUrl,gateway]){
        assert.equal((await get(base,null)).status,401);assert.equal((await get(base,'invalid')).status,401);
        for(const role of ['owner','staff','doctor'])assert.equal((await get(base,role)).status,403);
        for(const query of ['from=2030-02-30&to=2030-03-01','from=2030-10-20&to=2030-10-20&ownerId=x','from=2030-10-20&from=2030-10-20&to=2030-10-20'])assert.equal((await get(base,'admin',query)).status,422);
      }
      for(const base of [clinicUrl,gateway]){
        assert.ok(report.requestCount++<240);
        const r=await fetch(base+'/api/appointments?date=2030-10-20&category=medical&status=cancelled&page=1&pageSize=20',{
          headers:{authorization:'Bearer '+tokens.admin,'X-Clinic-Read-Consistency':'authoritative'},signal:AbortSignal.timeout(6000),redirect:'error'});
        assert.equal(r.status,200);assert.equal(r.headers.get('x-clinic-read-source'),'authoritative');
        const body=await r.json();
        const expectedRows=fixture.appointments.filter(a=>a.appointmentDate==='2030-10-20'&&!a.type.startsWith('spa_')&&a.status==='cancelled');
        assert.equal(body.pagination.total,expectedRows.length);
        assert.ok(body.items.every(a=>a.date==='2030-10-20'&&!a.type.startsWith('spa_')&&a.status==='cancelled'));
        report.cases.push({mode,operation:'daily-clinic-medical-status-authoritative-drilldown',entrypoint:base===gateway?'gateway':'direct',status:'PASS'});
      }
      if(mode==='cached'){
        const q='from=2030-10-20&to=2030-10-20',first=await (await get(clinicUrl,'admin',q)).json();assert.equal(first.meta.source,'source');
        const hit=await (await get(gateway,'admin',q)).json();assert.equal(hit.meta.source,'cached');assert.ok(hit.meta.cacheComputedAt);assert.ok(hit.meta.freshness.observedLagMs<5000);
        await sleep(5100);const expired=await (await get(gateway,'admin',q)).json();assert.equal(expired.meta.source,'source');
        report.cases.push({mode,operation:'absolute-cache-ttl-and-forwarded-metadata',status:'PASS'});
      }
      const setRole=async role=>{await guardDatabase(core,c,'core');await core.user.update({where:{id:users.admin.id},data:{role}});};
      if(mode==='cached'){
        const query='from=2030-10-18&to=2030-10-18';
        report.warmCacheRoleProof=await verifyWarmCacheRoleRevocation({setRole,read:async entrypoint=>{
          const r=await get(entrypoint==='direct'?clinicUrl:gateway,'admin',query);return {status:r.status,body:await r.json()};
        }});
        report.cases.push({mode,operation:'role-revocation-with-verified-live-cache',status:'PASS'});
      }else{
        try{await setRole('staff');for(const base of [clinicUrl,gateway])assert.equal((await get(base)).status,403);}
        finally{await setRole('admin');}
        report.cases.push({mode,operation:'current-role-revocation',status:'PASS'});
      }
      const apiRole=trialUrl(c,'clinic','api').username;
      await guardDatabase(clinic,c,'clinic');
      await clinic.$executeRawUnsafe(`REVOKE SELECT ON "${c.schema}".appointments FROM "${apiRole}"`);
      try{
        for(const base of [clinicUrl,gateway]){
          const r=await get(base,'admin','from=2030-10-19&to=2030-10-19');assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'1');
        }
      }finally{await guardDatabase(clinic,c,'clinic');await clinic.$executeRawUnsafe(`GRANT SELECT ON "${c.schema}".appointments TO "${apiRole}"`);}
      report.cases.push({mode,operation:'bounded-source-failure-through-gateway',status:'PASS'});
      const forged=await get(gateway,'admin','from=2030-10-20&to=2030-10-20',{'X-Clinic-Activity-Mode':'summary','X-Clinic-Read-Consistency':'projection'});assert.equal(forged.status,200);
      const forgedBody=await forged.json();assert.notEqual(forgedBody.meta.source,'summary');
      report.cases.push({mode,operation:'strict-params-and-client-mode-cannot-switch-reader',status:'PASS',gatewayPort:port});
      try{
        const result=await verifyGatewayBrowser({gateway,mode,setRole,expected,
          login:JSON.parse(readFileSync(resolve(c.directory,'browser-login.json'),'utf8')),
          expectedRows:fixture.appointments.filter(a=>a.appointmentDate==='2030-10-20'&&!a.type.startsWith('spa_')&&a.status==='cancelled').map(a=>a.id)});
        browserReport.modes.push(result);
      }catch(error){browserReport.status='FAIL';browserReport.modes.push({mode,status:'FAIL',errorType:error.name});throw error;}
      finally{save('browser.json',browserReport);}
    }finally{
      try{if(!spawnError)await stopChild(nginx);}finally{await closeServer(frontendServer);await closeServer(coreServer);await closeServer(clinicServer);await coreApi.$disconnect();await clinicApi.$disconnect();}
    }
  }
  browserReport.status='PASS_IN_SCOPE';report.status='PASS_IN_SCOPE';
  }catch(error){report.status='FAIL';report.errorType=error.name;throw error;}
  finally{
    if(browserReport.status==='STARTING')browserReport.status='NOT_COMPLETED';
    save('browser.json',browserReport);save('http.json',report);
  }
}
let result={kind:'D1_TRIAL_ACTION_NOT_BENCHMARK',action,status:'FAIL',performance:'NOT_RUN'};
try{await guardDatabase(core,c,'core');await guardDatabase(clinic,c,'clinic');if(action!=='identity')await (action==='seed'?seed():action==='plans'?plans():http());result.status='PASS_IN_SCOPE';}
catch(error){result.errorType=error.name;result.errorCode=typeof error.code==='string'&&/^[A-Z_0-9]{1,64}$/.test(error.code)?error.code:null;process.exitCode=1;}
finally{
  for(const cleanup of cleanupTasks.reverse())try{await cleanup();}catch{result.status='FAIL';result.errorCode='OWNED_PROCESS_CLEANUP_FAILED';process.exitCode=1;}
  await core.$disconnect();await clinic.$disconnect();save(action+'-action.json',result);console.log(JSON.stringify(result));
}
