import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import amqp from 'amqplib';
import net from 'node:net';
import {context,client,guard,broker} from './q4-trial.mjs';
import {AppointmentRebuild} from '../../../services/clinic/dist/readRebuild.js';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {ReadFreshness,probeReadQueue} from '../../../services/clinic/dist/readFreshness.js';
import {ReadTokens} from '../../../services/clinic/dist/readToken.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {BusinessError} from '../../../services/clinic/dist/domain/error.js';
import {ReadDiagnostics} from '../../../services/clinic/dist/readDiagnostics.js';
import {ServingAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/servingAppointments.js';
import {topology,declareTopology,consumeEvents,publishConfirmed} from '../../../packages/messaging/dist/index.js';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)
const c=context(process.env.CQRS_Q4_CONTEXT),db=client(c,6),operator=client(c),engine=new AppointmentRebuild(operator),projector=new AppointmentProjector(db),routes=topology(c.prefix);
const secret='q4-trial-'+randomUUID(),actors={owner:{sub:randomUUID(),role:'owner'},other:{sub:randomUUID(),role:'owner'},admin:{sub:randomUUID(),role:'admin'}};
const pets=[{id:randomUUID(),ownerId:actors.owner.sub,name:'Q4 pet A',directoryVersion:1},{id:randomUUID(),ownerId:actors.other.sub,name:'Q4 pet B',directoryVersion:1}];
const servers=[],apps=[],results=[];let conn,ch,consumer,generation=randomUUID(),a,createToken,createBody,createKey,coreDown=false;
const freshness=new ReadFreshness(db),codec=new ReadTokens(secret);
const mark=name=>results.push({name,status:'PASS'});
const source={acceptsService:()=>true,request:async(actor,_token,ids)=>{
 if(coreDown)throw new BusinessError(503,'Core unavailable');
 if(actor.role==='owner'&&(ids.petIds??[]).some(id=>pets.find(p=>p.id===id)?.ownerId!==actor.sub))throw new BusinessError(403,'Denied');
 const found=pets.filter(p=>(ids.petIds??[]).includes(p.id));return {actor:{...actor,fullName:'Q4 actor'},pets:found,owners:[...new Set([...(ids.ownerIds??[]),...found.map(p=>p.ownerId)])].map(id=>({id,fullName:'Q4 owner',directoryVersion:1})),...(ids.doctorId?{doctor:{id:ids.doctorId,fullName:'Q4 doctor'}}:{})};
}};
async function http(path,{method='GET',body,actor='owner',token,key,replica=0,headers={}}={}){
 const r=await fetch('http://127.0.0.1:'+servers[replica].address().port+'/api'+path,{method,headers:{Authorization:'Bearer '+actor,'Content-Type':'application/json',...(token?{'X-Clinic-Min-Version':token}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,body:r.status===204?null:await r.json(),source:r.headers.get('x-clinic-read-source'),token:r.headers.get('x-clinic-read-token'),generation:r.headers.get('x-clinic-projection-generation'),retry:r.headers.get('retry-after'),diagnosticId:r.headers.get('x-clinic-read-diagnostic-id')};
}
async function catchUp(){for(const row of await db.outboxEvent.findMany({orderBy:{createdAt:'asc'}}))if(row.envelope.eventType==='clinic.appointment-read-changed.v1')await projector.apply(JSON.stringify(row.envelope));await freshness.sample();}
test.before(async()=>{
 await guard(db,c);await declareTopology(broker,routes);conn=await amqp.connect(broker);ch=await conn.createConfirmChannel();
 const run=randomUUID();await engine.claim(run,generation);while(!(await engine.batch(run)).done){}await engine.verify(run);await engine.activate(run);await engine.close();
 await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{servingMode:'projection'}});
 consumer=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));
 Object.assign(process.env,{CLINIC_READ_MODE:'projection',CLINIC_READ_TOKEN_SECRET:secret,BROKER_URL:broker,BROKER_PREFIX:c.prefix});
 await freshness.sample();assert.ok(freshness.usable(generation));
 for(let i=0;i<2;i++){const app=createApp(db,t=>{if(!actors[t])throw new Error('Invalid');return actors[t];},source,undefined,freshness);apps.push(app);const s=app.listen(0,'127.0.0.1');await once(s,'listening');servers.push(s);}
});
test.after(async()=>{
 for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
 await freshness.close();await consumer?.close();await ch?.close();await conn?.close();await engine.close();await operator.$disconnect();await db.$disconnect();
 writeFileSync(c.output+'/cases.json',JSON.stringify({run:c.run,results,retained:true},null,2));
});
test('freshness probe forcibly closes its owned transport when broker CloseOk is unavailable',async()=>{
 const sockets=new Set();let dropped=false;
 const proxy=net.createServer(socket=>{
  const upstream=net.connect(5679,'127.0.0.1');sockets.add(socket);sockets.add(upstream);
  for(const s of [socket,upstream]){s.on('error',()=>{});s.on('close',()=>sockets.delete(s));}
  socket.on('close',()=>upstream.destroy());upstream.pipe(socket);let buffer=Buffer.alloc(0),protocol=true;
  socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(protocol){if(buffer.length<8)return;upstream.write(buffer.subarray(0,8));buffer=buffer.subarray(8);protocol=false;}
    while(buffer.length>=7){const size=buffer.readUInt32BE(3)+8;if(buffer.length<size)return;const frame=buffer.subarray(0,size);buffer=buffer.subarray(size);
      if(frame[0]===1&&frame.readUInt16BE(1)===0&&frame.readUInt16BE(7)===10&&frame.readUInt16BE(9)===50)dropped=true;else upstream.write(frame);
    }
  });
 });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const prior=process.env.BROKER_URL;
 try{
  const url=new URL(broker);url.port=String(proxy.address().port);process.env.BROKER_URL=url.href;
  const start=performance.now();assert.equal(await probeReadQueue(),true);assert.ok(dropped);assert.ok(performance.now()-start<3000);
  const end=Date.now()+1000;while(sockets.size&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(sockets.size,0);mark('bounded-broker-probe-close');
 }finally{process.env.BROKER_URL=prior;for(const s of sockets)s.destroy();await new Promise(r=>proxy.close(r));}
});
test('HTTP commit token survives dedup replay on another replica without increasing revision',async()=>{
 createKey=randomUUID();createBody={petId:pets[0].id,type:'general_checkup',serviceName:'Q4 exam',date:'2040-04-01',time:'09:00'};
 const r=await http('/appointments',{method:'POST',body:createBody,key:createKey});assert.equal(r.status,201);a=r.body.appointment;createToken=r.token;
 assert.equal(codec.verify(createToken,actors.owner)[a.id],1);
 const replay=await http('/appointments',{method:'POST',body:createBody,key:createKey,replica:1});assert.deepEqual(replay.body,r.body);assert.equal(codec.verify(replay.token,actors.owner)[a.id],1);
 assert.equal((await db.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:a.id}}})).version,1);mark('commit-dedup-two-replicas');
});
test('lagging RYW falls back whole query; catchup permits projection with matching counts and calendar',async()=>{
 const start=performance.now(),r=await http('/appointments',{token:createToken});assert.equal(r.status,200);assert.equal(r.source,'authoritative');assert.equal(r.body.items[0].id,a.id);assert.equal(r.body.counts.pending,1);assert.ok(performance.now()-start<1500);
 await catchUp();const p=await http('/appointments',{token:createToken,replica:1});assert.equal(p.source,'projection');assert.equal(p.generation,generation);assert.deepEqual(p.body,r.body);
 const calendar=await http('/appointments/calendar?month=2040-04',{token:createToken});assert.equal(calendar.source,'projection');assert.equal(calendar.body['2040-04-01'],1);mark('ryw-whole-query-fallback-catchup');
});
test('token malformed expired forged oversized wrong actor and role fail before projected query; Core still authorizes',async()=>{
 for(const token of ['bad',createToken.slice(0,-2)+'xx','x'.repeat(4097),new ReadTokens(secret,()=>Date.now()-601000).issue(actors.owner,{[a.id]:1})]){const r=await http('/appointments',{token});assert.equal(r.status,422);}
 assert.equal((await http('/appointments',{actor:'other',token:createToken})).status,403);
 assert.equal((await http('/appointments',{actor:'admin',token:createToken})).status,403);
 assert.equal((await http('/appointments?petId='+pets[0].id,{actor:'other'})).status,403);
 coreDown=true;assert.equal((await http('/appointments',{token:createToken})).status,503);coreDown=false;
 assert.equal((await http('/appointments',{actor:'missing'})).status,401);mark('token-and-core-authorization');
});
test('reschedule status undo medical completion issue exact committed versions and preserve historic dedup version',async()=>{
 const change=async(path,body,method='PATCH',actor='admin')=>{const r=await http('/appointments/'+a.id+path,{method,body,actor});assert.equal(r.status,200,JSON.stringify(r.body));a=r.body.appointment;assert.ok(codec.verify(r.token,actors[actor])[a.id]>1);return r;};
 await change('/reschedule',{date:'2040-04-02',time:'10:00',expectedRevision:a.statusRevision},'PATCH','owner');
 await change('/status',{status:'confirmed',expectedRevision:a.statusRevision,internalNote:'Q4_PRIVATE'});
 await change('/status',{status:'checked_in',expectedRevision:a.statusRevision});
 await change('/undo-status',{reason:'Trial correction',expectedRevision:a.statusRevision},'POST');
 await change('/status',{status:'checked_in',expectedRevision:a.statusRevision});
 const m=await http('/medical-records',{method:'POST',actor:'admin',key:randomUUID(),body:{petId:pets[0].id,appointmentId:a.id,doctorId:'q4-doctor',visitDate:'2040-04-02',title:'Q4 medical',diagnosis:'Trial',treatment:'Trial'}});assert.equal(m.status,201);assert.equal(codec.verify(m.token,actors.admin)[a.id],7);
 const replay=await http('/appointments',{method:'POST',body:createBody,key:createKey});assert.equal(codec.verify(replay.token,actors.owner)[a.id],1);assert.equal(replay.body.appointment.status,'pending');
 await catchUp();const r=await http('/appointments',{token:m.token,actor:'admin'});assert.equal(r.source,'projection');assert.equal(r.body.items[0].status,'completed');assert.equal(r.body.items[0].internalNote,'Q4_PRIVATE');
 assert.ok(!(await http('/appointments')).body.items.some(x=>'internalNote'in x));mark('mutation-lifecycle-medical-dedup');
});
test('pending token waits for actual broker delivery within bounded polling budget',async()=>{
 const r=await http('/appointments',{method:'POST',key:randomUUID(),body:{...createBody,time:'11:00'}});assert.equal(r.status,201);
 const row=await db.outboxEvent.findFirstOrThrow({where:{envelope:{path:['aggregateId'],equals:r.body.appointment.id}}});
 const job=new Promise((resolve,reject)=>setTimeout(()=>publishConfirmed(ch,routes.exchange,'clinic.appointment-read-changed.v1',Buffer.from(JSON.stringify(row.envelope)),{messageId:row.id,persistent:true}).then(resolve,reject),60));
 const read=await http('/appointments',{token:r.token});await job;assert.equal(read.source,'projection');assert.ok(read.body.items.some(x=>x.id===r.body.appointment.id));mark('broker-catchup-bounded-wait');
});
test('freshness expiry lag over budget broker DLQ and unknown generation degrade, unbilled always source',async()=>{
 await catchUp();const old=freshness.evidence;
 freshness.evidence={...old,sampledAt:Date.now()-6001};assert.equal((await http('/appointments')).source,'authoritative');
 freshness.evidence={...old,sampledAt:Date.now(),lagMs:5001};assert.equal((await http('/appointments')).source,'authoritative');
 await publishConfirmed(ch,'',routes.clinicRead+'.dlq',Buffer.from('q4 retained malformed fixture'),{messageId:randomUUID()});await freshness.sample();assert.equal(freshness.evidence,undefined);assert.equal((await http('/appointments')).source,'authoritative');
 // Keep DLQ evidence; later tests can use an explicit deterministic probe.
 freshness.evidence={...old,sampledAt:Date.now()};assert.equal((await http('/appointments?mode=unbilled')).source,'authoritative');
 await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{activeGenerationId:null}});assert.equal((await http('/appointments')).source,'authoritative');await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{activeGenerationId:generation}});mark('freshness-fail-closed-unbilled');
});
test('source ownership/existence fences projected items counts calendar and related despite old projection',async()=>{
 const old=freshness.evidence;freshness.evidence={...old,sampledAt:Date.now()};
 await db.appointment.update({where:{id:a.id},data:{ownerId:actors.other.sub,petId:pets[1].id}});
 const r=await http('/appointments?id='+a.id);assert.equal(r.source,'projection');assert.equal(r.body.items.length,0);assert.equal(r.body.pagination.total,0);assert.equal(r.body.related.pets.length,0);
 assert.equal((await http('/appointments/calendar?month=2040-04')).body['2040-04-02'],undefined);
 await db.appointment.update({where:{id:a.id},data:{ownerId:actors.owner.sub,petId:pets[0].id}});mark('stale-owner-source-fence');
});
test('projection statement timeout under a real read-model lock still returns authoritative data',async()=>{
 freshness.evidence={generation,sampledAt:Date.now(),lagMs:0,healthy:true};
 let release,ready;const held=new Promise(r=>release=r),acquired=new Promise(r=>ready=r);
 const blocker=operator.$transaction(async tx=>{await tx.$executeRawUnsafe('LOCK TABLE "AppointmentReadRow" IN ACCESS EXCLUSIVE MODE');ready();await held;},{timeout:10000});await acquired;
 try{const r=await http('/appointments',{actor:'admin'});assert.equal(r.status,200);assert.equal(r.source,'authoritative');assert.ok(r.body.items.length>0);if(process.env.CLINIC_READ_DIAGNOSTICS==='1')assert.match(r.diagnosticId,/^[1-9][0-9]*$/);}
 finally{release();await blocker;}
 mark('projection-statement-timeout-fallback');
});

test('exhausted real pool records acquisition failure before setup and recovers without increasing maxWait',async()=>{
 const one=client(c,1),events=[];
 try{
 await guard(one,c);
 const diagnostics=new ReadDiagnostics(true,line=>events.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))));
 const serving=new ServingAppointmentQueries(one,freshness,diagnostics);
 let release,ready,queryEntered=false;const held=new Promise(r=>release=r),acquired=new Promise(r=>ready=r);
 const blocker=one.$transaction(async()=>{ready();await held;},{timeout:10000});await acquired;
 try{
  await assert.rejects(diagnostics.run('admin-unbilled',()=>serving.read(async()=>{queryEntered=true;return 1;},{},true)),e=>e.code==='P2028');
  assert.equal(queryEntered,false);const errors=events.filter(e=>e.event==='fallback_error');assert.equal(errors.length,1);
  assert.equal(errors[0].stage,'fallback-acquire');assert.equal(errors[0].prismaCode,'P2028');assert.equal(errors[0].reason,'forced_source');
 }finally{release();await blocker;}
 assert.equal((await serving.read(async()=>1,{},true)).data,1);mark('real-pool-acquire-recovery');
 }finally{await one.$disconnect();}
});
test('read-model outage falls back while source outage returns 503; bounded fallback rejects third request',async()=>{
 freshness.evidence={...freshness.evidence,sampledAt:Date.now()};
 await db.$executeRawUnsafe('ALTER TABLE "AppointmentReadRow" RENAME TO "Q4ReadUnavailable"');
 try{const r=await http('/appointments');assert.equal(r.status,200);assert.equal(r.source,'authoritative');if(process.env.CLINIC_READ_DIAGNOSTICS==='1')assert.match(r.diagnosticId,/^[1-9][0-9]*$/);else assert.equal(r.diagnosticId,null);}finally{await db.$executeRawUnsafe('ALTER TABLE "Q4ReadUnavailable" RENAME TO "AppointmentReadRow"');}
 freshness.evidence=undefined;
 let release,ready;const held=new Promise(r=>release=r),acquired=new Promise(r=>ready=r);
 const blocker=operator.$transaction(async tx=>{await tx.$executeRawUnsafe('LOCK TABLE appointments IN ACCESS EXCLUSIVE MODE');ready();await held;},{timeout:10000});await acquired;
 const first=http('/appointments'),second=http('/appointments');
 try{const end=Date.now()+1000;while(apps[0].locals.appointmentServing.stats.fallback<2&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
   // Observe actual source lock wait before requesting the over-budget read.
   let waiting=0;while(Date.now()<end){const [r]=await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;waiting=r.n;if(waiting>=2)break;await new Promise(r=>setTimeout(r,10));}assert.ok(waiting>=2);
   const third=await http('/appointments');assert.equal(third.status,503);assert.equal(third.retry,'1');
   if(process.env.CLINIC_READ_DIAGNOSTICS==='1')assert.match(third.diagnosticId,/^[1-9][0-9]*$/);else assert.equal(third.diagnosticId,null);
 }finally{release();await blocker;}
 assert.equal((await first).status,200);assert.equal((await second).status,200);
 await db.$executeRawUnsafe('ALTER TABLE appointments RENAME TO q4_source_unavailable');
 try{assert.equal((await http('/appointments')).status,503);}finally{await db.$executeRawUnsafe('ALTER TABLE q4_source_unavailable RENAME TO appointments');}
 mark('outage-and-fallback-admission');
});
