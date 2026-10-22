import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {readFileSync,writeFileSync} from 'node:fs';
import amqp from 'amqplib';
import {context,client,guard,broker} from './q5-trial.mjs';
import {AppointmentRebuild} from '../../../services/clinic/dist/readRebuild.js';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
import {ReadTokens} from '../../../services/clinic/dist/readToken.js';
import {OutboxRelay} from '../../../services/clinic/dist/relay.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {topology,declareTopology,consumeEvents,publishConfirmed} from '../../../packages/messaging/dist/index.js';
import {waitForQueueIdle} from '../test-project.mjs';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)

const policyBytes=readFileSync('phase2-plan/cqrs/acceptance.json'),policy=JSON.parse(policyBytes);
const c=context(process.env.CQRS_Q5_CONTEXT),db=client(c,6),operator=client(c),workerDbs=[client(c,2),client(c,2)],probeDb=client(c);
const generation=randomUUID(),routes=topology(c.prefix),secret='q5-trial-'+randomUUID();
const actors={owner:{sub:randomUUID(),role:'owner'},admin:{sub:randomUUID(),role:'admin'}},pet=randomUUID(),codec=new ReadTokens(secret);
const freshness=new ReadFreshness(probeDb),projectors=workerDbs.map(d=>new AppointmentProjector(d)),servers=[],apps=[],workers=[];
const results={run:c.run,policySha256:createHash('sha256').update(policyBytes).digest('hex'),cases:[],races:[],freshness:[],recovery:[]};
let conn,ch,sequence=0,relayRunning=false,relayJob,relayError;
const nap=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,ms=15000){const end=performance.now()+ms;while(performance.now()<end){if(relayError)throw new Error('Q5_RELAY_FAILED');const value=await check();if(value)return value;await nap(10);}throw new Error('Timeout: '+label);}
const source={acceptsService:()=>true,request:async actor=>({actor:{...actor,fullName:'Q5 synthetic actor'},pets:[{id:pet,ownerId:actors.owner.sub,name:'Q5 synthetic pet',directoryVersion:1}],owners:[{id:actors.owner.sub,fullName:'Q5 synthetic owner',directoryVersion:1}]})};
async function http(path,{method='GET',body,replica=0,actor='admin',token,key,headers={}}={}){
 const r=await fetch('http://127.0.0.1:'+servers[replica].address().port+'/api'+path,{method,headers:{Authorization:'Bearer '+actor,'Content-Type':'application/json',...(token?{'X-Clinic-Min-Version':token}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 return {status:r.status,body:await r.json(),source:r.headers.get('x-clinic-read-source'),token:r.headers.get('x-clinic-read-token')};
}
function slot(){const n=sequence++;return {date:new Date(Date.UTC(2041,0,1+Math.floor(n/600))).toISOString().slice(0,10),time:String(8+Math.floor(n%600/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')};}
async function create(extra={},replica=0){const r=await http('/appointments',{method:'POST',actor:'owner',key:randomUUID(),replica,body:{petId:pet,type:'spa_bath',serviceName:'Q5 synthetic',...slot(),...extra}});assert.equal(r.status,201);return r;}
async function status(a,value){const r=await http('/appointments/'+a.id+'/status',{method:'PATCH',body:{status:value,expectedRevision:a.statusRevision}});assert.equal(r.status,200);return r.body.appointment;}
async function startWorkers(){for(let i=0;i<2;i++)workers.push(await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projectors[i].apply(raw)));}
async function stopWorkers(){await Promise.all(workers.splice(0).map(w=>w.close()));}
function startRelay(){assert.equal(relayRunning,false);relayRunning=true;const relay=new OutboxRelay(db,broker);relayJob=(async()=>{while(relayRunning){if(!await relay.once('q5',routes))await nap(10);}})().catch(e=>{relayError=e;relayRunning=false;});}
async function stopRelay(){relayRunning=false;await relayJob;if(relayError)throw new Error('Q5_RELAY_FAILED');}
async function diff(){const [r]=await db.$queryRaw`SELECT count(*)::int AS n FROM "ClinicReadRevision" r LEFT JOIN "AppointmentReadRow" p ON p."appointmentId"=r."aggregateId" AND p.generation=${generation} WHERE r.kind='appointment' AND NOT r.deleted AND (p."appointmentId" IS NULL OR p."sourceVersion"<>r.version)`;return r.n;}
async function caughtUp(){await until(async()=>await db.outboxEvent.count({where:{publishedAt:null}})===0&&await diff()===0,'outbox/projector catchup',120000);await waitForQueueIdle([routes.clinicRead]);assert.equal((await ch.checkQueue(routes.clinicRead+'.dlq')).messageCount,0);
 // The legacy queue-idle helper invokes docker synchronously. A background
 // probe already in flight can expire while that CLI blocks Node. Wait for a
 // new usable sample after it returns; do not fabricate/extend evidence.
 await until(async()=>{await freshness.sample();return freshness.usable(generation);},'fresh readiness evidence',15000);
}
async function disk(){return db.$queryRaw`SELECT relname,pg_table_size(c.oid)::text AS table_bytes,pg_indexes_size(c.oid)::text AS index_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${c.schema} AND c.relkind='r' ORDER BY relname`;}
async function lockWait(count=1){await until(async()=>{const [r]=await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name=${c.schema} AND wait_event_type='Lock'`;return r.n>=count;},'observed SQL lock wait',2000);}
async function rowBarrier(id,first,second){const ready=Promise.withResolvers(),release=Promise.withResolvers();const holding=operator.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;ready.resolve();await release.promise;},{timeout:10000});await ready.promise;let one,two;try{one=first();await lockWait();two=second();await lockWait(2);}finally{release.resolve();await holding;}return Promise.all([one,two]);}
const save=()=>writeFileSync(c.output+'/cases.json',JSON.stringify(results,null,2));
function mark(name){results.cases.push({name,status:'PASS'});save();console.log('Q5 PASS '+name);}

test.before(async()=>{
 await guard(db,c);await declareTopology(broker,routes);conn=await amqp.connect(broker);ch=await conn.createConfirmChannel();
 const engine=new AppointmentRebuild(operator),run=randomUUID();try{await engine.claim(run,generation);while(!(await engine.batch(run)).done){}await engine.verify(run);await engine.activate(run);}finally{await engine.close();}
 await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{servingMode:'projection'}});
 Object.assign(process.env,{CLINIC_READ_MODE:'projection',CLINIC_READ_TOKEN_SECRET:secret,BROKER_URL:broker,BROKER_PREFIX:c.prefix});
 await startWorkers();freshness.start();for(let i=0;i<2;i++){const app=createApp(db,t=>{assert.ok(actors[t]);return actors[t];},source,undefined,freshness);apps.push(app);const s=app.listen(0,'127.0.0.1');await once(s,'listening');servers.push(s);}
 results.diskBefore=await disk();startRelay();
});
test.after(async()=>{
 try{await stopRelay();await stopWorkers();await freshness.close();results.diskAfter=await disk();results.remainingConsumers=(await ch.checkQueue(routes.clinicRead)).consumerCount;}finally{
  for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await ch?.close();await conn?.close();await Promise.all([db,operator,probeDb,...workerDbs].map(d=>d.$disconnect()));save();
 }
});

test('100 status versus undo races, alternating SQL lock winner across two APIs',{timeout:180000},async()=>{
 for(let i=0;i<policy.correctness.racePairsPerScenario;i++){
  let a=(await create()).body.appointment;a=await status(a,'confirmed');a=await status(a,'checked_in');
  const next=()=>http('/appointments/'+a.id+'/status',{method:'PATCH',replica:0,body:{status:'in_progress',expectedRevision:a.statusRevision}});
  const undo=()=>http('/appointments/'+a.id+'/undo-status',{method:'POST',replica:1,body:{expectedRevision:a.statusRevision,reason:'Q5 barrier race'}});
  const pair=await rowBarrier(a.id,i%2?undo:next,i%2?next:undo);assert.deepEqual(pair.map(r=>r.status),[200,409]);
  const row=await db.appointment.findUniqueOrThrow({where:{id:a.id}});assert.equal(row.status,i%2?'confirmed':'in_progress');assert.equal(row.statusRevision,3);
  assert.equal((await db.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:a.id}}})).version,4);
  results.races.push({scenario:'status-undo',pair:i,winner:i%2?'undo':'status',status:pair.map(r=>r.status)});
 }mark('status-undo-100-barrier-pairs');
});

test('100 slot unique races, first insert held before commit and other API blocked on unique constraint',{timeout:180000},async()=>{
 // Test-only trigger in the fresh UUID schema; not a production migration/failpoint.
 await db.$executeRawUnsafe(`CREATE FUNCTION q5_slot_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.service_name='Q5 slot gate' THEN PERFORM pg_advisory_xact_lock(78451015); END IF; RETURN NEW; END $$`);
 await db.$executeRawUnsafe('CREATE TRIGGER q5_slot_gate AFTER INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION q5_slot_gate()');
 try{for(let i=0;i<policy.correctness.racePairsPerScenario;i++){
  const shared=slot(),ready=Promise.withResolvers(),release=Promise.withResolvers();
  const hold=operator.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(78451015)::text`;ready.resolve();await release.promise;},{timeout:10000});await ready.promise;
  const body={petId:pet,type:'spa_bath',serviceName:'Q5 slot gate',...shared};let first,second;
  try{first=http('/appointments',{method:'POST',actor:'owner',replica:i%2,key:randomUUID(),body});await lockWait();second=http('/appointments',{method:'POST',actor:'owner',replica:1-i%2,key:randomUUID(),body});await lockWait(2);}finally{release.resolve();await hold;}
  const pair=await Promise.all([first,second]);assert.deepEqual(pair.map(r=>r.status),[201,409]);
  assert.equal(await db.appointment.count({where:{petId:pet,appointmentDate:new Date(shared.date),appointmentTime:shared.time}}),1);
  results.races.push({scenario:'slot',pair:i,winnerReplica:i%2,status:pair.map(r=>r.status)});
 }}finally{await db.$executeRawUnsafe('DROP TRIGGER q5_slot_gate ON appointments');await db.$executeRawUnsafe('DROP FUNCTION q5_slot_gate()');}mark('slot-100-barrier-pairs');
});

test('three full HTTP freshness/RYW runs of 1000 accepted mutations; retain every sample',{timeout:900000},async()=>{
 await caughtUp();
 for(let run=0;run<policy.freshness.runs;run++){
  const samples=[];results.freshness.push({run,samples,status:'RUNNING'});
  for(let n=0;n<policy.freshness.mutationsPerRun;n++){
   const write=await create({},n%2),accepted=performance.now(),a=write.body.appointment,version=codec.verify(write.token,actors.owner)[a.id];
   const sample={n,id:a.id,version,status:'STARTING'};samples.push(sample);
   try{
    const read=await http('/appointments?id='+a.id,{actor:'owner',replica:1-n%2,token:write.token});
    sample.rywStatus=read.status;sample.rywSource=read.source;sample.rywMs=performance.now()-accepted;
    assert.equal(read.status,200);assert.equal(read.body.items[0]?.id,a.id);assert.equal(read.body.items[0].statusRevision,a.statusRevision);assert.equal(read.body.pagination.total,1);
    await until(async()=>{const r=await http('/appointments?id='+a.id,{actor:'owner',replica:n%2});return r.status===200&&r.source==='projection'&&r.body.items[0]?.id===a.id;},'projected HTTP freshness',10000);
    sample.visibleMs=performance.now()-accepted;
    assert.ok((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation,appointmentId:a.id}}})).sourceVersion>=version);sample.status='PASS';
   }catch(e){sample.status='FAIL';save();throw e;}
   if((n+1)%100===0){console.log('Q5 freshness run '+(run+1)+' '+(n+1)+'/1000');save();}
  }
  const sorted=samples.map(s=>s.visibleMs).sort((a,b)=>a-b),report=results.freshness.at(-1);report.p95Ms=sorted[Math.ceil(sorted.length*.95)-1];report.p99Ms=sorted[Math.ceil(sorted.length*.99)-1];
  assert.ok(report.p95Ms<=policy.freshness.p95MsMax);assert.ok(report.p99Ms<=policy.freshness.p99MsMax);report.status='PASS';save();
 }mark('freshness-ryw-3x1000');
});

test('ten duplicate deliveries with two projectors; no duplicate inbox/read effect',async()=>{
 await caughtUp();const event=await db.outboxEvent.findFirstOrThrow({where:{envelope:{path:['eventType'],equals:'clinic.appointment-read-changed.v1'}}});
 const before=projectors.reduce((sum,p)=>sum+p.stats.duplicates,0);
 for(let n=0;n<policy.correctness.replayDeliveriesPerEvent;n++)await publishConfirmed(ch,routes.exchange,event.envelope.eventType,Buffer.from(JSON.stringify(event.envelope)),{messageId:event.id});
 await until(()=>projectors.reduce((sum,p)=>sum+p.stats.duplicates,0)-before===10,'10 broker duplicate ACKs');await waitForQueueIdle([routes.clinicRead]);
 assert.equal(await db.inboxEvent.count({where:{consumerName:'clinic-read-v1:'+generation,eventId:event.id}}),1);assert.equal(await diff(),0);mark('two-projectors-ten-duplicates');
});

test('three 60-second projector outages, <=5 events/s, full version recovery and zero valid DLQ',{timeout:600000},async()=>{
 for(let run=0;run<policy.recovery.runs;run++){
  await caughtUp();await stopWorkers();const start=performance.now(),expected=[];
  // 4/s target leaves headroom under the frozen <=5/s input ceiling.
  for(let n=0;n<240;n++){
   if(n)await nap(250);const r=await create();expected.push({id:r.body.appointment.id,version:codec.verify(r.token,actors.owner)[r.body.appointment.id],acceptedMs:performance.now()-start});
   if(n%40===0)console.log('Q5 outage '+(run+1)+' elapsed '+Math.round((performance.now()-start)/1000)+'s');
  }
  await nap(Math.max(0,policy.recovery.projectorOutageSeconds*1000-(performance.now()-start)));
  const report={run,outageMs:performance.now()-start,expected,status:'RECOVERING'};results.recovery.push(report);save();
  assert.equal((await ch.checkQueue(routes.clinicRead)).consumerCount,0);assert.ok(await diff()>0);
  const fallback=await http('/appointments?id='+expected.at(-1).id);assert.equal(fallback.status,200);assert.equal(fallback.source,'authoritative');
  const restart=performance.now();await startWorkers();await caughtUp();report.catchUpMs=performance.now()-restart;
  assert.ok(report.catchUpMs<=policy.recovery.catchUpSecondsMax*1000);assert.equal(await diff(),0);report.validDlq=(await ch.checkQueue(routes.clinicRead+'.dlq')).messageCount;assert.equal(report.validDlq,0);
  for(const item of expected){assert.equal((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation,appointmentId:item.id}}})).sourceVersion,item.version);}
  report.status='PASS';save();
 }mark('projector-outage-recovery-3x60s');
});

test('rollback both APIs while lagging retains committed source and works without projection tables or token configuration',async()=>{
 await caughtUp();await stopWorkers();const write=await create(),id=write.body.appointment.id;assert.equal(await db.appointmentReadRow.count({where:{appointmentId:id}}),0);
 const counts={appointments:await db.appointment.count(),revision:await db.clinicReadRevision.count(),outbox:await db.outboxEvent.count(),dedup:await db.requestDedup.count()};
 for(let i=0;i<2;i++){
  servers[i].closeAllConnections();await new Promise(r=>servers[i].close(r));process.env.CLINIC_READ_MODE='authoritative';
  const app=createApp(db,t=>actors[t],source);const s=app.listen(0,'127.0.0.1');await once(s,'listening');servers[i]=s;apps[i]=app;
  const r=await http('/appointments?id='+id,{actor:'owner',replica:i,token:write.token});assert.equal(r.status,200);assert.equal(r.source,'authoritative');assert.equal(r.body.items[0].id,id);
 }
 await db.$executeRawUnsafe('ALTER TABLE "AppointmentReadRow" RENAME TO "Q5ReadUnavailable"');
 try{for(let i=0;i<2;i++){assert.equal((await http('/appointments?id='+id,{actor:'owner',replica:i})).body.items[0].id,id);}}
 finally{await db.$executeRawUnsafe('ALTER TABLE "Q5ReadUnavailable" RENAME TO "AppointmentReadRow"');}
 delete process.env.CLINIC_READ_TOKEN_SECRET;const noToken=createApp(db,t=>actors[t],source).listen(0,'127.0.0.1');await once(noToken,'listening');servers.push(noToken);
 assert.equal((await http('/appointments?id='+id,{actor:'owner',replica:2})).status,200);assert.equal((await http('/appointments?id='+id,{actor:'owner',replica:2,token:write.token})).status,422);
 assert.deepEqual({appointments:await db.appointment.count(),revision:await db.clinicReadRevision.count(),outbox:await db.outboxEvent.count(),dedup:await db.requestDedup.count()},counts);
 await startWorkers();await caughtUp();assert.equal(await diff(),0);results.rollback={replicas:2,counts,projectionTableUnavailable:true,tokenOptional:true};mark('rollback-authoritative-two-replicas');
});
