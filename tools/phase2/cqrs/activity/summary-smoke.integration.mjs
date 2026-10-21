// D5 local functional smoke of S/C/P (V2 schema, 10k then 100k) and L (separate
// V1-only schema/queue/worker) over real HTTP, real PG/RabbitMQ, built workers
// and the real relay. Open-loop generator with raw outcomes retained. Smoke only:
// latencies are not graded (policy performanceMeasurementsAllowed=false).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {assertTestProject} from '../../test-project.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {recordAppointmentChange,initializeAppointmentProjection} from '../../../../services/clinic/dist/readRevision.js';
import {AppointmentRebuild} from '../../../../services/clinic/dist/readRebuild.js';
import {OutboxRelay} from '../../../../services/clinic/dist/relay.js';
import {reconcileProjection} from '../../../../services/clinic/dist/projectionSnapshot.js';
import {summaryDrift} from '../../../../services/clinic/dist/clinicActivitySummary.js';
import {ReadFreshness,probeReadQueue} from '../../../../services/clinic/dist/readFreshness.js';
import {ActivitySummaryEvidence,AuditLane} from '../../../../services/clinic/dist/activitySummaryEvidence.js';
import {createApp} from '../../../../services/clinic/dist/app.js';
import {topology,declareTopology} from '../../../../packages/messaging/dist/index.js';
import {buildActivityFixture} from './fixture.mjs';
import {productPlan,runPlan,generatorValidity} from './bench/generator.mjs';
import {classify} from './bench/evaluator.mjs';

assertTestProject();
const contextPath=resolve(process.env.ACTIVITY_D2_CONTEXT??'');
assert.ok(contextPath.startsWith(resolve('test-results/phase2/cqrs/activity')+sep));
const c=JSON.parse(readFileSync(contextPath,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.suite,'d5s');assert.equal(c.schema,'activity_d5s_'+hex);assert.equal(c.marker,'clinic-activity-d5s:'+c.run);
const base=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');
const urlFor=(schema,limit)=>{const u=new URL(base);u.searchParams.set('schema',schema);u.searchParams.set('connection_limit',String(limit));return u;};
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
// Separate V1 schema for L (same build, explicit V1-only capability), own queue.
const lSchema='activity_d5l_'+hex,lMarker='clinic-activity-d5l:'+c.run;
const v2={schema:c.schema,prefix:'p2.activity-d5s.'+c.run},v1={schema:lSchema,prefix:'p2.activity-d5l.'+c.run};
for(const s of [v2,v1]){s.url=urlFor(s.schema,6);s.db=new PrismaClient({datasourceUrl:s.url.href});s.op=new PrismaClient({datasourceUrl:urlFor(s.schema,1).href});s.routes=topology(s.prefix);}
const results=[],children=[],smoke=[];const raw=resolve(c.output,'request-raw.jsonl');
const save=()=>writeFileSync(resolve(c.output,'smoke-cases.json'),JSON.stringify({run:c.run,schemas:[v2.schema,v1.schema],scope:'LOCAL_FUNCTIONAL_SMOKE_NOT_TIMING',results,smoke},null,2));
const mark=(name,extra={})=>{results.push({name,status:'PASS',...extra});save();};
const fail=(name,error)=>{results.push({name,status:'FAIL',error:String(error?.message??error).slice(0,2000)});save();};
const nap=ms=>new Promise(r=>setTimeout(r,ms));
// Cached reader TTL (clinicActivity.ts): after quiesce, parity is compared only
// once any pre-quiesce cached snapshot has expired (cached may lag by policy).
const cacheTtlMs=5000;
const close=servers=>{for(const x of servers){x.server.closeAllConnections();x.server.close();}};
const scenarios=[{name:'primary30day',q:'from=2030-09-21&to=2030-10-20'},{name:'12month',q:'from=2029-11-01&to=2030-10-20&groupBy=month'},
  {name:'clinic',q:'from=2030-09-21&to=2030-10-20&category=clinic'},{name:'spa',q:'from=2030-09-21&to=2030-10-20&category=spa'},{name:'zero',q:'from=2040-01-01&to=2040-01-30'}];
function worker(s,extra={}){const p=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...process.env,DATABASE_URL:s.url.href,BROKER_URL:broker,BROKER_PREFIX:s.prefix,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1',...extra},stdio:['ignore','pipe','pipe','ipc']});
  children.push(p);p.logs='';p.stdout.on('data',b=>p.logs+=b);p.stderr.on('data',b=>p.logs+=b);return p;}
const ready=async p=>{const end=Date.now()+30000;while(Date.now()<end){if(p.exitCode!==null)throw new Error('worker exited '+p.logs.slice(-300));if(p.logs.includes('worker-ready'))return;await nap(50);}throw new Error('worker not ready');};
function relay(s){s.stop=false;s.loop=(async()=>{const r=new OutboxRelay(s.db,broker);while(!s.stop){try{if(!await r.once('d5s',s.routes))await nap(100);}catch{await nap(250);}}})();}
async function seed(s,rows,offset=0){const f=buildActivityFixture({rows,seed:20261020+offset});
  // A different seed yields distinct appointment/pet ids; per-pet times stay unique (slot index).
  for(let i=0;i<f.appointments.length;i+=2500)await s.db.appointment.createMany({data:f.appointments.slice(i,i+2500).map(a=>({...a,appointmentDate:new Date(a.appointmentDate),createdAt:new Date(a.createdAt),updatedAt:new Date(a.updatedAt)}))});
  return f.manifest.contentSha256;}
async function rebuild(s,schemaVersion){const e=new AppointmentRebuild(s.op),run=randomUUID(),g=randomUUID();
  try{await e.claim(run,g,{schemaVersion});while(!(await e.batch(run,2000)).done){}if(schemaVersion===2)await e.summarize(run);await e.verify(run);await e.activate(run);}finally{await e.close();}return g;}
let writeIndex=0;
async function write(s){const i=writeIndex++,kind=i%5===0?'create':i%5===1?'reschedule':'status';
  const t=Date.now();await s.db.$transaction(async tx=>{
    if(kind==='create'){const id=randomUUID();await tx.appointment.create({data:{id,petId:randomUUID(),ownerId:randomUUID(),type:i%2?'spa_combo':'surgery',serviceName:'D5 smoke',clinicName:'Fixture',appointmentDate:new Date('2030-10-'+String(1+i%20).padStart(2,'0')),appointmentTime:'04:00'}});await recordAppointmentChange(tx,id,{created:true});return;}
    const [a]=await tx.$queryRaw`SELECT id FROM appointments WHERE appointment_date BETWEEN '2030-09-21' AND '2030-10-20' ORDER BY id OFFSET ${i%200} LIMIT 1 FOR UPDATE`;
    await tx.appointment.update({where:{id:a.id},data:kind==='status'?{status:['confirmed','cancelled','completed','no_show'][i%4]}:{appointmentDate:new Date('2030-10-'+String(1+i%20).padStart(2,'0'))}});
    await recordAppointmentChange(tx,a.id);});
  return {result:'success',status:201,ms:Date.now()-t,operation:kind};}
async function caughtUp(s,g,summary){const rows=await s.db.$transaction(tx=>reconcileProjection(tx,g),{timeout:30000});if(Object.values(rows).some(n=>n!==0))return false;
  if(!summary)return true;const d=await s.db.$transaction(tx=>summaryDrift(tx,g,{source:true}),{timeout:30000});return d.rows===0&&d.source===0;}
async function quiesce(s,g,summary){const t=Date.now();while(!await caughtUp(s,g,summary)){if(Date.now()-t>120000)throw new Error('not caught up');await nap(250);}}
// One configuration: in-process Clinic HTTP app with the mode under test; the
// evidence samplers run for every V2 configuration (identical maintenance).
async function smokeRun(label,s,{mode,generation,rows,evidence,seconds=30}){
  const prev=process.env.CLINIC_ACTIVITY_MODE;process.env.CLINIC_ACTIVITY_MODE=mode;
  const app=createApp(s.db,t=>{if(t!=='admin')throw new Error('invalid');return {sub:'d5-admin',role:'admin'};},{acceptsService:()=>true,request:async a=>({actor:{...a,fullName:'D5'},pets:[],owners:[]})},undefined,undefined,evidence);
  process.env.CLINIC_ACTIVITY_MODE=prev;if(prev===undefined)delete process.env.CLINIC_ACTIVITY_MODE;
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
  const plan=productPlan({screens:10,pollMs:1500,warmupMs:3000,measuredMs:seconds*1000,writesPerSecond:1});
  const run={id:`${label}-${rows}`,label,expectedGeneration:generation,simpleReader:mode==='cached'?'C':'S'};
  try{
    const out=await runPlan(plan,async op=>{
      if(op.kind==='write')return write(s);
      const sc=scenarios[(op.screen+op.id)%scenarios.length],r=await fetch(url+'/api/dashboard/clinic/activity?'+sc.q,{headers:{Authorization:'Bearer admin'},signal:AbortSignal.timeout(10000)});
      const body=await r.json();return {result:'success',status:r.status,scenario:sc.name,source:body.meta?.source,generation:body.meta?.generation??null,degraded:body.meta?.degraded,reason:body.meta?.reason,total:body.current?.total};
    },{maxInFlight:32});
    for(const rec of out.records)appendFileSync(raw,JSON.stringify({run:run.id,label,rows,...rec})+'\n');
    const counts={};for(const rec of out.records.filter(r=>r.measured)){const k=classify(run,rec).code;counts[k]=(counts[k]??0)+1;}
    const validity=generatorValidity(plan,out.records),scenariosSeen=[...new Set(out.records.filter(r=>r.kind==='read').map(r=>r.outcome.scenario))].sort();
    const entry={run:run.id,label,mode,rows,generation,counts,validity,scenariosSeen};smoke.push(entry);save();
    assert.deepEqual(Object.keys(counts),['success'],JSON.stringify(counts));assert.equal(validity.valid,true,JSON.stringify(validity));
    assert.deepEqual(scenariosSeen,scenarios.map(x=>x.name).sort());
    // Zero-data scenario returns explicit zeros, not an error.
    assert.ok(out.records.filter(r=>r.outcome.scenario==='zero').every(r=>r.outcome.total===0));
    return {url,server};
  }catch(error){server.closeAllConnections();server.close();throw error;}
}
async function parity(url,label){const out={};for(const sc of scenarios){out[sc.name]=await (await fetch(url+'/api/dashboard/clinic/activity?'+sc.q,{headers:{Authorization:'Bearer admin'}})).json();}return out;}
const business=r=>{const {meta,...rest}=r;return rest;};

test.before(async()=>{
  assert.deepEqual(await v2.db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await v2.db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  assert.equal((await v2.db.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${lSchema}`).length,0);
  await v2.db.$executeRawUnsafe(`CREATE SCHEMA "${lSchema}"`);await v2.db.$executeRawUnsafe(`COMMENT ON SCHEMA "${lSchema}" IS '${lMarker}'`);
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:v1.url.href},stdio:'pipe'});
  for(const s of [v2,v1])await declareTopology(broker,s.routes);
});
test.after(async()=>{for(const s of [v2,v1]){s.stop=true;await s.loop;}for(const p of children)if(p.exitCode===null){const g=once(p,'exit');p.kill('SIGKILL');await g;}
  for(const s of [v2,v1]){await s.db.$disconnect();await s.op.$disconnect();}save();});

test('S/C/P smoke on 10k then 100k: every response from the configured path, valid writes projected, business parity after quiesce',{timeout:1200000},async()=>{
  const s=v2;const fixture10k=await seed(s,10000);await initializeAppointmentProjection(s.db,randomUUID());
  for(const [rows,extra] of [[10000,0],[100000,90000]]){
    if(extra)await seed(s,extra,1);
    const g=await rebuild(s,2);const w=worker(s);await ready(w);relay(s);
    process.env.BROKER_URL=broker;process.env.BROKER_PREFIX=s.prefix;
    const auditDb=new PrismaClient({datasourceUrl:urlFor(s.schema,1).href}),lane=new AuditLane(),rowsEv=new ReadFreshness(auditDb,probeReadQueue,undefined,undefined,{requireListProjection:false,perAggregateLag:true,lane}),ev=new ActivitySummaryEvidence(auditDb,rowsEv,[1,2],lane);
    rowsEv.start();ev.start();await nap(2500);
    const servers=[];
    try{
      for(const [label,mode] of [['S','source'],['C','cached'],['P','summary']])servers.push(await smokeRun(label,s,{mode,generation:g,rows,evidence:ev}));
      s.stop=true;await s.loop;await quiesce(s,g,true);await rowsEv.sample();await ev.sample();await nap(cacheTtlMs+500);
      const [S,C,P]=await Promise.all(servers.map(x=>parity(x.url)));
      for(const sc of scenarios){assert.deepEqual(business(P[sc.name]),business(S[sc.name]),sc.name);assert.deepEqual(business(C[sc.name]),business(S[sc.name]),sc.name);assert.equal(P[sc.name].meta.source,'summary',sc.name);}
      mark('SCP-smoke-'+rows,{generation:g,fixture10k});
    }catch(error){fail('SCP-smoke-'+rows,error);throw error;}finally{close(servers);await ev.close();await rowsEv.close();await auditDb.$disconnect();const gone=once(w,'exit');w.kill('SIGKILL');await gone;}
  }
});

test('L smoke: same build with explicit V1-only worker on a separate V1 schema/queue; source and cached readers; no summary maintained',{timeout:600000},async()=>{
  const s=v1;await seed(s,10000);await initializeAppointmentProjection(s.db,randomUUID());const g=await rebuild(s,1);
  const w=worker(s,{CLINIC_READ_PROJECTION_VERSIONS:'1'});await ready(w);assert.match(w.logs,/"projectionVersions":\[1\],"summaryEnabled":false/);relay(s);
  const servers=[];
  try{
    for(const [label,mode] of [['L','source'],['L','cached']])servers.push(await smokeRun(label,s,{mode,generation:null,rows:10000}));
    s.stop=true;await s.loop;await quiesce(s,g,false);await nap(cacheTtlMs+500);
    assert.equal(await s.db.appointmentDailySummary.count(),0);assert.equal((await s.db.readProjectionGeneration.findUniqueOrThrow({where:{id:g}})).schemaVersion,1);
    const [src,cache]=await Promise.all(servers.map(x=>parity(x.url)));for(const sc of scenarios)assert.deepEqual(business(cache[sc.name]),business(src[sc.name]));
    mark('L-v1-only-smoke',{generation:g,workerCapability:'[1]'});
  }catch(error){fail('L-v1-only-smoke',error);throw error;}finally{close(servers);const gone=once(w,'exit');w.kill('SIGKILL');await gone;}
});
