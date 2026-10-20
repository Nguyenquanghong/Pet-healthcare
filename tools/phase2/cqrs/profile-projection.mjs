// Q6 diagnosis only: fixed marked trial DB, synthetic directory, no Core/JWT benchmark.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {assertTestProject} from '../test-project.mjs';
import {appointmentRows} from '../../../benchmarks/phase2/kaggle/query_dataset.mjs';
import {prepareReadModel,guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {ServingAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/servingAppointments.js';
import {ProjectedAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';
import {AuthoritativeAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/authoritativeAppointments.js';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
import {responseHash} from '../../../services/clinic/dist/infrastructure/queries/shadowAppointments.js';

const args=process.argv.slice(2);
if(args.join(' ')==='--help'){console.log('Usage: profile-projection.mjs --run [--fixture <context.json>] [--analyze] [--migrate] [--seconds 5..300] [--parallel-workers 1]\nFixed marked Clinic trial only. Fresh 100k fixture by default; reuse requires matching UUID/schema marker. --analyze updates planner statistics, --migrate applies pending migrations only after verifying the trial marker. SQL plans, bounded serving and response parity; no HTTP/Core/JWT or capacity claim.');process.exit(0);}
assert.equal(args.shift(),'--run');let fixture,analyze=false,migrate=false,seconds=5,parallelWorkers;
while(args.length){const key=args.shift();if(key==='--fixture'){assert.ok(!fixture);fixture=args.shift();assert.ok(fixture);}else if(key==='--analyze'){assert.ok(!analyze);analyze=true;}else if(key==='--migrate'){assert.ok(!migrate);migrate=true;}else if(key==='--parallel-workers'){parallelWorkers=Number(args.shift());assert.equal(parallelWorkers,1);}else if(key==='--seconds'){seconds=Number(args.shift());assert.ok(Number.isInteger(seconds)&&seconds>=5&&seconds<=300);}else assert.fail('Unknown option');}
assertTestProject();
const output=resolve('test-results/phase2/cqrs/projection-profile-'+randomUUID());mkdirSync(output,{recursive:true});
let c;if(fixture){const path=resolve(fixture);assert.ok(path.startsWith(resolve('test-results/phase2/cqrs')+sep));c=JSON.parse(readFileSync(path,'utf8'));}else{const run=randomUUID();c={kind:'cqrs-q6-local-v1',run,schema:'cqrs_q6_'+run.replaceAll('-','')};}
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','1');
const adminDb=new PrismaClient({datasourceUrl:url.href});let apiDb,freshness;
const report={status:'STARTING',run:c.run,schema:c.schema,analyze,migrate,seconds,parallelWorkers:parallelWorkers??null,rate:12,concurrency:16,scope:'PG diagnostic; synthetic directory and broker-health fixture, not HTTP/native benchmark',output,requests:[],sql:[],plans:[],parity:[]};
const local=new AsyncLocalStorage(),queries=new Map();let stage='guard';
const errorCode=e=>({code:/^[A-Z][A-Z0-9_]{0,40}$/.test(e.code??'')?e.code:'OTHER',sqlState:/^[0-9A-Z]{5}$/.test(e.meta?.code??'')?e.meta.code:null});
try{
  assert.deepEqual(await adminDb.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await adminDb.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.match(c.run,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(c.schema,'cqrs_q6_'+c.run.replaceAll('-',''));assert.equal(c.kind,'cqrs-q6-local-v1');
  if(!fixture){
    assert.equal((await adminDb.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${c.schema}`).length,0);
    await adminDb.$executeRawUnsafe(`CREATE SCHEMA "${c.schema}"`);await adminDb.$executeRawUnsafe(`COMMENT ON SCHEMA "${c.schema}" IS 'cqrs-q6:${c.run}'`);
    await guard(adminDb,url,c);stage='migrate';
    execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
    stage='fixture';
    for(let n=0;n<100;n++){
      const owner=randomUUID(),pet=randomUUID(),rows=appointmentRows(owner,pet,n);
      await adminDb.directoryProjection.createMany({data:[{kind:'owner',id:owner,displayName:'Synthetic '+n,sourceVersion:1},{kind:'pet',id:pet,ownerId:owner,displayName:'Mèo thử '+n,sourceVersion:1}]});
      for(let start=0;start<rows.length;start+=500)await adminDb.appointment.createMany({data:rows.slice(start,start+500)});
      await adminDb.appointmentReservation.createMany({data:rows.filter((_,i)=>i%17===0).map((a,i)=>({operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:0,snapshot:{},state:['HELD','INVOICED','RELEASED'][i%3]}))});
    }
    for(const table of ['appointments','AppointmentReservation','DirectoryProjection'])await adminDb.$executeRawUnsafe(`ANALYZE "${table}"`);
    stage='rebuild';const prepared=await prepareReadModel('B',url.href,c);c.generation=prepared.generation;report.rebuild=prepared.rebuild;
    writeFileSync(resolve(output,'context.json'),JSON.stringify(c,null,2));
  }else{
    await guard(adminDb,url,c);
    if(migrate)execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
  }
  assert.equal(await adminDb.appointment.count(),100000);assert.equal(await adminDb.appointmentReadRow.count({where:{generation:c.generation}}),100000);
  const statistics=()=>adminDb.$queryRaw`SELECT relname,n_live_tup::text,last_analyze,last_autoanalyze FROM pg_stat_user_tables WHERE schemaname=current_schema() AND relname IN ('AppointmentReadRow','ClinicReadRevision') ORDER BY relname`;
  report.statisticsBefore=await statistics();
  if(analyze){for(const t of ['AppointmentReadRow','ClinicReadRevision'])await adminDb.$executeRawUnsafe(`ANALYZE "${t}"`);}
  report.statisticsAfter=await statistics();
  const records=await adminDb.directoryProjection.findMany(),pets=records.filter(r=>r.kind==='pet').map(r=>({id:r.id,ownerId:r.ownerId,name:r.displayName,directoryVersion:1})),owners=records.filter(r=>r.kind==='owner').map(r=>({id:r.id,fullName:r.displayName,directoryVersion:1}));
  const directory={lookup:async(pids,oids)=>({pets:pets.filter(p=>pids.includes(p.id)),owners:owners.filter(o=>oids.includes(o.id))}),pet:async id=>pets.find(p=>p.id===id)};
  const owner={role:'owner',sub:pets[0].ownerId},admin={role:'admin',sub:c.run};
  const operations=[['owner-list',r=>r.list(owner,directory,{})],['admin-list',r=>r.list(admin,directory,{pageSize:'100'})],['admin-search',r=>r.list(admin,directory,{q:'Mèo',pageSize:'100'})],['admin-unbilled',r=>r.list(admin,directory,{mode:'unbilled'})],['owner-calendar',r=>r.calendar(owner,{month:'2028-02'})],['admin-calendar',r=>r.calendar(admin,{month:'2028-02'})],['admin-filter',r=>r.list(admin,directory,{category:'spa',statusGroup:'pending',date:'2028-02-01'})],['admin-page',r=>r.list(admin,directory,{page:'500',pageSize:'100'})]];
  url.searchParams.set('connection_limit','4');apiDb=new PrismaClient({datasourceUrl:url.href});
  function instrument(db){return new Proxy(db,{get(target,key){
    if(key==='$transaction')return async(work,options)=>{const started=performance.now(),row=local.getStore();try{return await target.$transaction(tx=>{if(row)(row.admissionMs??=[]).push(performance.now()-started);return work(instrument(tx));},options);}catch(e){if(row)(row.errors??=[]).push(errorCode(e));throw e;}};
    if(key==='$executeRawUnsafe')return async(sql,...values)=>{if(parallelWorkers!==undefined&&sql==="SET LOCAL plan_cache_mode='force_custom_plan'")await target.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=1');return target.$executeRawUnsafe(sql,...values);};
    if(key==='$queryRaw')return async(sql,...rest)=>{const started=performance.now(),row=local.getStore(),text=sql.text??sql.join('?'),id=createHash('sha256').update(text+JSON.stringify(sql.values??rest)).digest('hex');if(sql.text&&!queries.has(id))queries.set(id,sql);const event={operation:row?.operation,phase:row?.phase,id};try{return await target.$queryRaw(sql,...rest);}catch(e){event.error=errorCode(e);throw e;}finally{report.sql.push({...event,ms:performance.now()-started});}};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});}
  freshness=new ReadFreshness(adminDb,async()=>true);await freshness.sample();assert.ok(freshness.usable(c.generation));freshness.start();
  const serving=new ServingAppointmentQueries(instrument(apiDb),freshness);
  stage='bounded-serving';
  for(const [operation,run] of operations){const row={phase:'serial',operation};report.requests.push(row);await local.run(row,async()=>{const t=performance.now();try{const r=await serving.read(run,{},operation==='admin-unbilled');row.source=r.source;}catch(e){row.error=errorCode(e);}row.ms=performance.now()-t;});}
  const start=performance.now(),active=new Set();
  for(let i=0;i<seconds*12;i++){
    await delay(Math.max(0,start+i*1000/12-performance.now()));const [operation,run]=operations[i%8],row={phase:'concurrent',operation,sequence:i};report.requests.push(row);
    row.schedulerLagMs=Math.max(0,performance.now()-start-i*1000/12);
    if(active.size>=16){row.error={code:'GENERATOR_DROP'};continue;}
    const task=local.run(row,async()=>{const t=performance.now();try{const r=await serving.read(run,{},operation==='admin-unbilled');row.source=r.source;}catch(e){row.error=errorCode(e);}row.ms=performance.now()-t;});active.add(task);task.finally(()=>active.delete(task));
  }await Promise.all(active);report.servingStats=serving.stats;await freshness.close();
  stage='parity-plans';
  // Ungated diagnosis may exceed Prisma's default 5s transaction budget.
  // This facade is used only for plans/parity, never the bounded serving phase.
  const diagnosticDb=new Proxy(apiDb,{get(target,key){if(key==='$transaction')return (work,options)=>target.$transaction(work,{...options,timeout:60000});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  for(const [operation,run] of operations){
    const row={phase:'parity',operation};await local.run(row,async()=>{const expected=await run(new AuthoritativeAppointmentQueries(diagnosticDb));const actual=await run(new ProjectedAppointmentQueries(instrument(diagnosticDb),c.generation));assert.equal(responseHash(actual),responseHash(expected),operation);report.parity.push(operation);});
  }
  // Exercise status-bucket boundaries, filtered buckets and out-of-range pages
  // on the full-size fixture. Compare complete responses, not query structure.
  for(const actor of [owner,admin])for(const raw of [{page:'2',pageSize:'100'},{page:'143',pageSize:'100'},{page:'286',pageSize:'100'},{page:'1001',pageSize:'100'},{page:'143',pageSize:'100',statusGroup:'pending'},{page:'2',pageSize:'100',status:'completed'}]){
    const expected=await new AuthoritativeAppointmentQueries(diagnosticDb).list(actor,directory,raw);
    const actual=await new ProjectedAppointmentQueries(diagnosticDb,c.generation).list(actor,directory,raw);
    assert.equal(responseHash(actual),responseHash(expected));report.parity.push(actor.role+':'+JSON.stringify(raw));
  }
  for(const [id,sql] of queries){
    const plan=await adminDb.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");if(parallelWorkers!==undefined)await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=1');return tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql.text,...sql.values);},{timeout:35000});
    report.plans.push({id,sql:sql.text,plan});
  }
  report.status='DIAGNOSTIC_COMPLETE';
  report.boundedPath=report.requests.every(r=>!r.error&&r.source===(r.operation==='admin-unbilled'?'authoritative':'projection'))?'PASS':'FAIL';
}catch(e){report.status='FAIL';report.stage=stage;report.error=errorCode(e);process.exitCode=1;}
finally{await freshness?.close();await apiDb?.$disconnect();await adminDb.$disconnect();writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,stage,output,servingStats:report.servingStats,parity:report.parity.length}));}
