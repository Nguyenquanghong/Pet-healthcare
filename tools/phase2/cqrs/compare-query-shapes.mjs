// Read-only SQL screening on an existing UUID-labelled collector trial.
// This does not select a production reader or change its serving budgets.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {captureStatement,sanitizePlan} from '../../../benchmarks/phase2/kaggle/cqrs_query_plans.mjs';
import {ProjectedAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';

const args=process.argv.slice(2);
if(args.join(' ')==='--help'){
  console.log('Usage: compare-query-shapes.mjs --run <query-plans-UUID/context.json>\nStarts only that stopped UUID-labelled postgres:16-alpine collector trial, verifies volume/loopback/marker and 100k rows. Read-only ACL edge cases and six balanced rounds of real counts/calendar SQL: current JOIN, EXISTS+CASE, EXISTS+equalities, JOIN+row guard. Fingerprints before/after; stops container. No build, seed, migration, index or runtime edits. PASS means parity only, not performance acceptance.');process.exit(0);
}
assert.equal(args.length,2);assert.equal(args[0],'--run');
const path=resolve(args[1]);assert.ok(path.startsWith(resolve('test-results/phase2/cqrs')+sep));
const c=JSON.parse(readFileSync(path,'utf8'));
assert.equal(c.kind,'phase2-kaggle-native-v1');assert.equal(c.datasetProfile,'query-heavy');assert.equal(c.cqrsConfiguration,'B');assert.equal(c.replicas,1);
assert.match(c.run,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(path,resolve('test-results/phase2/cqrs/query-plans-'+c.run+'/context.json'));
const name='cqrs-plan-'+c.run,volume=name+'-data',label='pet.cqrs.plan-trial';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:45000});
function identity(){
  const i=JSON.parse(docker(['inspect',name]))[0];
  assert.equal(i.Name,'/'+name);assert.equal(i.Config.Labels[label],c.run);assert.equal(i.Config.Image,'postgres:16-alpine');
  assert.equal(i.Mounts.length,1);assert.equal(i.Mounts[0].Name,volume);assert.equal(i.Mounts[0].Destination,'/var/lib/postgresql/data');
  assert.equal(JSON.parse(docker(['volume','inspect',volume]))[0].Labels[label],c.run);
  assert.equal(i.HostConfig.Memory,1073741824);assert.equal(i.HostConfig.NanoCpus,2000000000);
  assert.deepEqual(i.HostConfig.PortBindings,{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:''}]});
  return i;
}
const join='JOIN appointments a ON a.id=p."appointmentId"';
const acl='a.id=p."appointmentId" AND CASE WHEN a.owner_id=p."ownerId" AND a.pet_id=p."petId" THEN TRUE ELSE FALSE END';
const caseGuard='CASE WHEN a.owner_id=p."ownerId" AND a.pet_id=p."petId" THEN TRUE ELSE FALSE END';
function shape(text,mode){
  assert.equal(text.split(join).length,2);assert.equal(text.split(acl).length,2);assert.ok(!text.includes(';'));
  if(mode==='join')return text;
  if(mode==='join-row')return text.replace(caseGuard,'(ROW(a.owner_id,a.pet_id)=ROW(p."ownerId",p."petId")) IS TRUE');
  assert.ok(['exists-case','exists-equalities'].includes(mode));
  const predicate=mode==='exists-case'?acl:'a.id=p."appointmentId" AND a.owner_id=p."ownerId" AND a.pet_id=p."petId"';
  const stripped=text.replace(join,'').replace(acl,'__ACL__');assert.ok(!/\ba\./.test(stripped),'ADMIN_AGGREGATE_ONLY');
  return stripped.replace('__ACL__','EXISTS (SELECT 1 FROM appointments a WHERE '+predicate+')');
}
const modes=['join','exists-case','exists-equalities','join-row'];
const output=resolve('test-results/phase2/cqrs/query-shapes-'+randomUUID());mkdirSync(output,{recursive:true});
const report={status:'STARTING',trial:c.run,container:name,scope:'readonly SQL screening, not HTTP/native benchmark',capacityAccepted:false,cpuLimit:2,memoryBytes:1073741824,cases:[],results:[]};
let db,started=false,stage='identity';
try{
  assert.equal(identity().State.Status,'exited','STOPPED_TRIAL_REQUIRED');
  stage='start';docker(['start',name]);started=true;
  const info=identity(),bindings=info.NetworkSettings.Ports['5432/tcp'];
  assert.equal(bindings.length,1);assert.equal(bindings[0].HostIp,'127.0.0.1');
  c.pgPort=Number(bindings[0].HostPort);assert.ok(Number.isInteger(c.pgPort)&&c.pgPort>1024&&c.pgPort<=65535);report.pgPort=c.pgPort;
  const password=info.Config.Env.filter(e=>e.startsWith('POSTGRES_PASSWORD='));assert.equal(password.length,1);
  const url=new URL(`postgresql://p8_clinic@127.0.0.1:${c.pgPort}/p8_clinic?schema=public&connection_limit=1`);url.password=password[0].slice('POSTGRES_PASSWORD='.length);
  let ready=false;for(let i=0;i<40;i++){try{docker(['exec',name,'pg_isready','-U','postgres']);ready=true;break;}catch{await delay(500);}}assert.ok(ready);
  stage='marker';db=new PrismaClient({datasourceUrl:url.href});await guard(db,url,c);
  assert.equal(await db.appointment.count(),100000);
  const control=await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'},include:{activeGeneration:true}});
  assert.equal(control.activeGeneration.state,'ACTIVE');assert.ok(control.activeGeneration.verifiedAt);const generation=control.activeGenerationId;
  assert.equal(await db.appointmentReadRow.count({where:{generation}}),100000);
  // Every experiment, including the synthetic ACL fixture, is enforced read-only.
  const read=work=>db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000ms'");await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    assert.deepEqual(await tx.$queryRawUnsafe('SHOW transaction_read_only'),[{transaction_read_only:'on'}]);return work(tx);
  },{isolationLevel:'RepeatableRead',maxWait:250,timeout:15000});
  const fingerprint=()=>read(async tx=>{
    const out={};for(const table of ['appointments','AppointmentReservation','DirectoryProjection','ClinicReadRevision','AppointmentReadRow','ReadProjectionControl','ReadProjectionGeneration']){
      [out[table]]=await tx.$queryRawUnsafe(`SELECT count(*)::int AS n,md5(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text))) AS hash FROM "${table}" t`);
    }return out;
  });
  const before=await fingerprint();stage='acl';
  // Local VALUES shadow table names; no persistent rows or transaction writes.
  const fixture=`WITH appointments(id,owner_id,pet_id) AS (VALUES
    ('ok','o','p'),('owner','other','p'),('pet','o','other'),('both','other','other'),
    ('null-owner',NULL,'p'),('null-pet','o',NULL),('null-both',NULL,NULL),('projection-null','o','p'),('empty','','')),
    "AppointmentReadRow"("appointmentId","ownerId","petId") AS (VALUES
    ('ok','o','p'),('owner','o','p'),('pet','o','p'),('both','o','p'),('missing','o','p'),
    ('null-owner',NULL,'p'),('null-pet','o',NULL),('null-both',NULL,NULL),('projection-null',NULL,NULL),('empty','','')) `;
  for(const mode of modes){
    const sql=shape(`SELECT p."appointmentId" AS id FROM "AppointmentReadRow" p ${join} WHERE ${acl} ORDER BY p."appointmentId"`,mode);
    assert.deepEqual(await read(tx=>tx.$queryRawUnsafe(fixture+sql)),[{id:'empty'},{id:'ok'}]);report.cases.push(mode+': stale owner/pet, absent source, NULL denied');
  }
  stage='plans';
  const cases=[['admin-list',{pageSize:'100'}],['admin-search',{q:'M\u00e8o',pageSize:'100'}],['admin-page',{page:'500',pageSize:'100'}],['admin-calendar',{month:'2028-02'}]];
  for(let repeat=0;repeat<6;repeat++)for(const mode of repeat%2?[...modes].reverse():modes)for(const [operation,query] of cases){
    const result=await read(async tx=>{
      const sql=await captureStatement(tx,ProjectedAppointmentQueries,generation,operation,query),text=shape(sql.text,mode);
      const rows=(await tx.$queryRawUnsafe(text,...sql.values)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const plan=sanitizePlan(await tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+text,...sql.values));
      return {rows,plan,sqlShapeSha256:createHash('sha256').update(text).digest('hex')};
    });
    const prior=report.results.find(r=>r.operation===operation);if(prior)assert.deepEqual(result.rows,prior.rows);
    report.results.push({repeat,mode,operation,...result});
  }
  stage='unchanged';assert.deepEqual(await fingerprint(),before);report.fingerprints=before;report.cases.push('seven table fingerprints unchanged');
  report.status='PASS';
  report.summary=cases.flatMap(([operation])=>modes.map(mode=>{
    const times=report.results.filter(r=>r.operation===operation&&r.mode===mode).map(r=>r.plan['Execution Time']).sort((a,b)=>a-b);
    return {operation,mode,minMs:times[0],medianMs:(times[2]+times[3])/2,maxMs:times.at(-1)};
  }));console.log(JSON.stringify(report.summary));
}catch(error){report.status='FAIL';report.failedStage=stage;report.errorType=error.name;report.errorCode=/^P\d{4}$/.test(error.code??'')?error.code:null;report.sqlState=/^[0-9A-Z]{5}$/.test(error.meta?.code??'')?error.meta.code:null;process.exitCode=1;}
finally{
  await db?.$disconnect();
  if(started){try{identity();docker(['stop','--time','10',name]);report.containerStopped=true;}catch{report.containerStopped=false;process.exitCode=1;}}
  writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,failedStage:report.failedStage,plans:report.results.length,containerStopped:report.containerStopped,output}));
}
