// Real PostgreSQL verification of the native plan collector; not a native load benchmark.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {appointmentRows} from '../../../benchmarks/phase2/kaggle/query_dataset.mjs';
import {prepareReadModel,guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {collectQueryPlans} from '../../../benchmarks/phase2/kaggle/cqrs_query_plans.mjs';
import {verifyAggregateCache} from './aggregate-cache.integration.mjs';

if(process.argv.slice(2).join(' ')==='--help'){
  console.log('Usage: node tools/phase2/cqrs/run-query-plans.mjs --run [--aggregate-cache]\nRequires built Clinic and existing postgres:16-alpine image; creates a fresh labelled Docker container/volume and loopback port, marked trial DB with 100k synthetic appointments. Applies migrations only there. Default checks readonly plans/marker/lock/fingerprints; --aggregate-cache runs mutation/HTTP/parity and diagnostic ABBA loads. Stops container and retains volume/evidence. No build/pull/main DB/native performance claim.');process.exit(0);
}
const cacheExperiment=process.argv.slice(2).join(' ')==='--run --aggregate-cache';
assert.ok(cacheExperiment||process.argv.slice(2).join(' ')==='--run');
const run=randomUUID(),name='cqrs-plan-'+run,volume=name+'-data',label='pet.cqrs.plan-trial';
const output=resolve('test-results/phase2/cqrs/query-plans-'+run);mkdirSync(output,{recursive:true});
const report={status:'STARTING',run,container:name,volume,scope:'Docker PostgreSQL collector integration, not native load',capacityAccepted:false,cases:[]};
const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:45000});
let db,locker,created=false,stage='image';
function identity(){
  const info=JSON.parse(docker(['inspect',name]))[0];
  assert.equal(info.Name,'/'+name);assert.equal(info.Config.Labels[label],run);assert.equal(info.Config.Image,'postgres:16-alpine');
  const mount=info.Mounts.find(m=>m.Destination==='/var/lib/postgresql/data');assert.equal(mount?.Name,volume);
  const bindings=info.NetworkSettings.Ports['5432/tcp'];assert.equal(bindings.length,1);assert.equal(bindings[0].HostIp,'127.0.0.1');
  return Number(bindings[0].HostPort);
}
try{
  docker(['image','inspect','postgres:16-alpine']);
  const password=randomUUID();
  docker(['volume','create','--label',label+'='+run,volume]);
  docker(['run','-d','--pull','never','--name',name,'--label',label+'='+run,'--memory','1g','--cpus','2','-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432','--mount','type=volume,src='+volume+',dst=/var/lib/postgresql/data','postgres:16-alpine']);created=true;
  stage='ready';const pgPort=identity();report.pgPort=pgPort;
  let ready=false;for(let i=0;i<40;i++){try{docker(['exec',name,'pg_isready','-U','postgres']);ready=true;break;}catch{await delay(500);}}assert.ok(ready);
  stage='trial-create';identity();
  docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],`CREATE ROLE p8_clinic LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nCREATE DATABASE p8_clinic OWNER p8_clinic;\n`);
  const url=new URL(`postgresql://p8_clinic:${password}@127.0.0.1:${pgPort}/p8_clinic?schema=public&connection_limit=1`);
  const context={kind:'phase2-kaggle-native-v1',run,pgPort,datasetProfile:'query-heavy',cqrsConfiguration:'B',replicas:1};
  db=new PrismaClient({datasourceUrl:url.href});locker=new PrismaClient({datasourceUrl:url.href});
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p8_clinic',role:'p8_clinic'}]);
  assert.equal((await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`).length,0);
  await db.$executeRawUnsafe('CREATE SCHEMA p8_control');await db.$executeRawUnsafe('CREATE TABLE p8_control.marker(run text NOT NULL)');
  await db.$executeRaw`INSERT INTO p8_control.marker(run) VALUES (${run})`;await guard(db,url,context);
  writeFileSync(resolve(output,'context.json'),JSON.stringify(context,null,2));
  stage='migrate';
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe',timeout:60000});
  stage='fixture';console.log('Marked fresh trial; loading 100k synthetic appointments');
  for(let n=0;n<100;n++){
    const owner=randomUUID(),pet=randomUUID(),rows=appointmentRows(owner,pet,n);
    await db.directoryProjection.createMany({data:[{kind:'owner',id:owner,displayName:'Synthetic '+n,sourceVersion:1},{kind:'pet',id:pet,ownerId:owner,displayName:'Mèo thử '+n,sourceVersion:1}]});
    for(let i=0;i<rows.length;i+=500)await db.appointment.createMany({data:rows.slice(i,i+500)});
    await db.appointmentReservation.createMany({data:rows.filter((_,i)=>i%17===0).map((a,i)=>({operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:0,snapshot:{},state:['HELD','INVOICED','RELEASED'][i%3]}))});
  }
  for(const table of ['appointments','AppointmentReservation','DirectoryProjection'])await db.$executeRawUnsafe(`ANALYZE "${table}"`);
  stage='rebuild';report.rebuild=await prepareReadModel('B',url.href,context);console.log('Rebuild verified; collecting real plans');
  if(cacheExperiment){
    stage='aggregate-cache';report.cache=await verifyAggregateCache(db,url,context,output,sql=>docker(['exec','-i',name,'psql','-U','postgres','-d','p8_clinic','-v','ON_ERROR_STOP=1'],sql));report.cases.push(...report.cache.cases);report.status='PASS';
  }else{
  const fingerprint=async()=>{
    const result={};
    for(const table of ['appointments','AppointmentReservation','DirectoryProjection','ClinicReadRevision','AppointmentReadRow','ReadProjectionControl','ReadProjectionGeneration']){
      const rows=await db.$queryRawUnsafe(`SELECT count(*)::int AS n,md5(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text))) AS hash FROM "${table}" t`);result[table]=rows[0];
    }return result;
  };
  const before=await fingerprint();let readOnlyTransactions=0;
  const observed=new Proxy(db,{get(target,key){
    if(key==='$transaction')return (work,options)=>target.$transaction(async tx=>work(new Proxy(tx,{get(t,k){
      if(k==='$executeRawUnsafe')return async(sql,...values)=>{const result=await t.$executeRawUnsafe(sql,...values);if(sql==='SET TRANSACTION READ ONLY'){assert.deepEqual(await t.$queryRawUnsafe('SHOW transaction_read_only'),[{transaction_read_only:'on'}]);readOnlyTransactions++;}return result;};
      const value=Reflect.get(t,k);return typeof value==='function'?value.bind(t):value;
    }})),options);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  stage='collect';const plans=await collectQueryPlans(observed,url.href,context);
  writeFileSync(resolve(output,'query-plans.json'),JSON.stringify(plans,null,2));assert.equal(plans.status,'COLLECTED');assert.equal(plans.results.length,4);assert.equal(readOnlyTransactions,4);
  assert.ok(plans.results.every(r=>r.statements.length===r.statementCount&&r.statements.every(s=>s.plan['Execution Time']>=0&&!s.plan.truncated)));
  const encoded=JSON.stringify(plans);for(const privateText of [password,report.rebuild.generation,'Mèo','Synthetic','SELECT ','"Filter":','"Relation Name":'])assert.ok(!encoded.includes(privateText));
  report.cases.push('four operations / all bounded SQL parts / readonly transactions / sanitized export');
  stage='wrong-marker';await assert.rejects(collectQueryPlans(db,url.href,{...context,run:randomUUID()}));report.cases.push('wrong marker rejected');
  stage='lock-timeout';let release,locked;const held=new Promise(r=>{locked=r;}),releaseLock=new Promise(r=>{release=r;});
  const blocking=locker.$transaction(async tx=>{await tx.$executeRawUnsafe('LOCK TABLE "AppointmentReadRow" IN ACCESS EXCLUSIVE MODE');locked();await releaseLock;},{timeout:15000});
  try{
    await Promise.race([held,blocking.then(()=>assert.fail('lock ended early'))]);
    const blocked=await collectQueryPlans(db,url.href,context);writeFileSync(resolve(output,'query-plans-locked.json'),JSON.stringify(blocked,null,2));
    assert.equal(blocked.status,'PARTIAL');assert.ok(blocked.results.every(r=>r.status==='UNAVAILABLE'&&r.sqlState==='55P03'));
    report.cases.push('four lock timeouts retained as unavailable without retry');
  }finally{release();await blocking;}
  stage='unchanged';assert.deepEqual(await fingerprint(),before);report.fingerprints=before;report.cases.push('source/projection/control fingerprints unchanged by diagnosis');
  report.planSha256=createHash('sha256').update(JSON.stringify(plans,null,2)).digest('hex');report.status='PASS';
  }
}catch(error){report.status='FAIL';report.failedStage=stage;report.errorType=error.name;report.errorCode=/^P\d{4}$/.test(error.code??'')?error.code:null;process.exitCode=1;}
finally{
  await locker?.$disconnect();await db?.$disconnect();
  if(created){try{identity();docker(['stop','--time','10',name]);report.containerStopped=true;}catch{report.containerStopped=false;process.exitCode=1;}}
  writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,failedStage:report.failedStage,cases:report.cases,containerStopped:report.containerStopped,output}));
}
