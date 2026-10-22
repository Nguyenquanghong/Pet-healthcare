import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import amqp from 'amqplib';
import {context,client,guard,broker} from './q3-trial.mjs';
import {AppointmentRebuild} from '../../../services/clinic/dist/readRebuild.js';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {recordAppointmentChange} from '../../../services/clinic/dist/readRevision.js';
import {reconcileProjection} from '../../../services/clinic/dist/projectionSnapshot.js';
import {AuthoritativeAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/authoritativeAppointments.js';
import {ProjectedAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';
import {ShadowAppointmentQueries,snapshotDatabase} from '../../../services/clinic/dist/infrastructure/queries/shadowAppointments.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {topology,declareTopology,consumeEvents,publishConfirmed} from '../../../packages/messaging/dist/index.js';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)

const c=context(process.env.CQRS_Q3_CONTEXT),db=client(c,6),op=client(c),engine=new AppointmentRebuild(op),routes=topology(c.prefix);
const owners=[randomUUID(),randomUUID(),randomUUID()],actors=[{sub:owners[0],role:'owner'},{sub:owners[1],role:'owner'},{sub:randomUUID(),role:'admin'},{sub:randomUUID(),role:'doctor'}];
const pets=Array.from({length:14},(_,i)=>({id:randomUUID(),ownerId:owners[i%3],name:i%2?'Mèo Ánh':'Chó Bình',directoryVersion:1}));
const statuses=['pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'],types=['general_checkup','spa_bath','spa_combo','vaccination'];
let generation=randomUUID(),run=randomUUID(),server,connection,ch;const children=[],results=[];
const json=v=>JSON.parse(JSON.stringify(v));
const directory=actor=>({lookup:async(pids,oids)=>({actor:{...actor,fullName:'Fixture'},pets:[...new Set(pids)].map(id=>pets.find(p=>p.id===id)??{id,ownerId:owners[0],name:'Large',directoryVersion:1}),owners:[...new Set(oids)].map(id=>({id,fullName:'Nguyễn '+owners.indexOf(id),directoryVersion:1}))}),pet:async id=>{const p=pets.find(p=>p.id===id);assert.ok(p);return p;}});
const sourceReader=new AuthoritativeAppointmentQueries(db);
const cli=(command,r=run,g=generation)=>JSON.parse(execFileSync(process.execPath,['tools/phase2/cqrs/rebuild.mjs',command,process.env.CQRS_Q3_CONTEXT,...(command==='--dry-run'?[]:[r,g])],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
async function mutate(id,change){return db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;await tx.appointment.update({where:{id},data:change});return recordAppointmentChange(tx,id);});}
const eventFor=async id=>(await db.outboxEvent.findMany()).map(r=>r.envelope).filter(e=>e.aggregateId===id).at(-1);
const mark=(name,extra={})=>results.push({name,status:'PASS',...extra});
test.before(async()=>{
  await guard(db,c);await declareTopology(broker,routes);connection=await amqp.connect(broker);ch=await connection.createConfirmChannel();
  await db.directoryProjection.createMany({data:[...owners.map((id,i)=>({kind:'owner',id,sourceVersion:1,displayName:'Nguyễn '+i,email:'fixture'+i+'@example.test'})),...pets.map(p=>({kind:'pet',id:p.id,ownerId:p.ownerId,sourceVersion:1,displayName:p.name,breed:'Có dấu'}))]});
  await db.appointment.createMany({data:Array.from({length:420},(_,i)=>({id:randomUUID(),petId:pets[i%pets.length].id,ownerId:pets[i%pets.length].ownerId,type:types[i%4],status:statuses[i%7],serviceName:'Khám có dấu '+i,clinicName:'Trial',appointmentDate:new Date('2028-02-'+String(1+i%29).padStart(2,'0')),appointmentTime:String(Math.floor(i/60)).padStart(2,'0')+':'+String(i%60).padStart(2,'0'),ownerNote:'Q3_OWNER_'+i,internalNote:'Q3_PRIVATE_'+i,createdAt:new Date(1700000000000+i*1000),updatedAt:new Date(1700000000000+i*1000)}))});
  const held=await db.appointment.findMany({take:12,orderBy:{id:'asc'}});await db.appointmentReservation.createMany({data:held.map((a,i)=>({operationId:randomUUID(),appointmentId:a.id,revisionAtPrepare:0,snapshot:{},state:i%2?'INVOICED':'HELD'}))});
});
test.after(async()=>{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
  server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));
  await engine.close();await op.$disconnect();await db.$disconnect();await ch?.close();await connection?.close();
  writeFileSync(c.output+'/cases.json',JSON.stringify({run:c.run,results,retained:true,queues:routes},null,2));
});
test('dry-run is read-only; wrong schema marker refuses mutation; live consumers refuse freeze',async()=>{
  const before=await db.readRebuildRun.count();assert.equal(cli('--dry-run').mutation,false);assert.equal(await db.readRebuildRun.count(),before);
  const bad={...c,marker:'bad'};await assert.rejects(()=>guard(db,bad));
  const consumer=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',async()=>{});
  try{assert.throws(()=>cli('--run'));assert.equal(await db.readRebuildRun.count(),0);}finally{await consumer.close();}
  mark('dry-run-marker-consumer-guard');
});
test('process kill after committed batch retains durable fence and checkpoint; resume completes and activates authoritative',async()=>{
  const child=spawn(process.execPath,['tools/phase2/cqrs/rebuild-child.mjs'],{env:{...process.env,Q3_RUN:run,Q3_GENERATION:generation},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
  const [message]=await once(child,'message');assert.equal(message.stage,'batch-committed');child.kill('SIGKILL');await once(child,'exit');
  const checkpoint=await db.readRebuildRun.findUniqueOrThrow({where:{id:run}});assert.equal(checkpoint.copied,17);assert.equal(checkpoint.frozen,true);
  await assert.rejects(()=>db.appointment.updateMany({data:{clinicName:'Blocked'}}),/CLINIC_READ_REBUILD_FROZEN/);
  assert.equal((await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}})).activeGenerationId,null);
  const resumed=cli('--resume');assert.equal(resumed.status,'COMPLETE');assert.ok(Object.values(resumed.diff).every(n=>n===0));
  assert.equal(await db.appointmentReadRow.count({where:{generation}}),420);
  assert.equal((await db.readRebuildRun.findUniqueOrThrow({where:{id:run}})).copied,420);
  assert.ok(!/postgresql:\/\/|amqp:\/\/|Q3_PRIVATE/.test(logs));mark('real-kill-resume', {rows:420});
});
test('full list/calendar parity preserves filters, sorting, related, billing and owner redaction',async()=>{
  const projected=new ProjectedAppointmentQueries(db,generation),sample=await db.appointment.findFirstOrThrow();
  const matrix=[{}, {page:'2'}, {page:'999'}, {pageSize:'100'}, {id:sample.id}, {ownerId:owners[1]}, {petId:pets[0].id}, {q:'Mèo'}, {q:'Nguyễn'}, {q:'KHÁM CÓ DẤU'}, {q:'not-found'}, {q:'%'}, {q:'_'}, {date:'2028-02-29'}, {category:'spa'}, {category:'medical'}, {mode:'unbilled'}, ...statuses.map(status=>({status})),...['pending','completed','cancelled'].map(statusGroup=>({statusGroup})),{statusGroup:'pending',status:'completed'},{statusGroup:'pending',status:'confirmed'},{category:'spa',date:'2028-02-01',status:'completed'},{q:'Khám',petId:pets[0].id,pageSize:'100'},{mode:'unbilled',status:'completed',pageSize:'100'}];
  let cases=0;
  for(const actor of actors){for(const query of matrix){const a=await sourceReader.list(actor,directory(actor),query),p=await projected.list(actor,directory(actor),query);assert.deepEqual(json(p),json(a),JSON.stringify({role:actor.role,query}));if(actor.role==='owner')assert.ok(p.items.every(r=>r.ownerId===actor.sub&&!Object.hasOwn(r,'internalNote')));cases++;}
    for(const month of ['2028-02','2028-01','2028-12'])for(const category of [undefined,'medical','spa']){assert.deepEqual(await projected.calendar(actor,{month,category}),await sourceReader.calendar(actor,{month,category}));cases++;}}
  for(const query of [{page:'0'},{pageSize:'101'},{status:'bad'},{date:'2028-02-30'},{q:['x']}])await assert.rejects(()=>projected.list(actors[0],directory(actors[0]),query),e=>e.status===422);
  mark('query-matrix',{cases});
});
test('projected planning is transaction-local and preserves repeated calendar/list responses',async()=>{
  const isolated=client(c,1),reader=new ProjectedAppointmentQueries(isolated,generation);
  try{
    const before=await isolated.$queryRaw`SELECT current_setting('plan_cache_mode') AS mode`;
    for(let i=0;i<8;i++){
      assert.deepEqual(await reader.calendar(actors[2],{month:'2028-02'}),await sourceReader.calendar(actors[2],{month:'2028-02'}));
      assert.deepEqual(json(await reader.list(actors[2],directory(actors[2]),{page:'2',pageSize:'100'})),json(await sourceReader.list(actors[2],directory(actors[2]),{page:'2',pageSize:'100'})));
      assert.deepEqual(await isolated.$queryRaw`SELECT current_setting('plan_cache_mode') AS mode`,before);
    }
    mark('transaction-local-planning');
  }finally{await isolated.$disconnect();}
});

test('new generation rejects partial/corrupt verification, preserves source, CAS and explicit abort retain authoritative',async()=>{
  const r=randomUUID(),g=randomUUID();await engine.claim(r,g);await engine.batch(r,30);
  await assert.rejects(()=>op.$transaction(async tx=>{
    await tx.clinicReadRevision.create({data:{kind:'appointment',aggregateId:randomUUID(),version:1}});
    assert.equal((await reconcileProjection(tx,g)).registry,1);throw new Error('ROLLBACK_ORPHAN_FIXTURE');
  }),/ROLLBACK_ORPHAN_FIXTURE/);
  const competing=client(c),otherOperator=new AppointmentRebuild(competing);
  try{await assert.rejects(()=>otherOperator.claim(randomUUID(),randomUUID()),/OPERATOR_BUSY/);}finally{await otherOperator.close();await competing.$disconnect();}
  await assert.rejects(()=>engine.verify(r),/RECONCILIATION_MISMATCH/);await assert.rejects(()=>engine.activate(r),/NOT_READY/);
  while(!(await engine.batch(r,100)).done){}
  const item=await op.appointmentReadRow.findFirstOrThrow({where:{generation:g}});
  await op.appointmentReadRow.update({where:{generation_appointmentId:{generation:g,appointmentId:item.appointmentId}},data:{internalNote:'Corrupt'}});
  await assert.rejects(()=>engine.verify(r),/RECONCILIATION_MISMATCH/);
  assert.notEqual((await db.appointment.findUniqueOrThrow({where:{id:item.appointmentId}})).internalNote,'Corrupt');
  await op.appointmentReadRow.update({where:{generation_appointmentId:{generation:g,appointmentId:item.appointmentId}},data:{internalNote:item.internalNote}});
  await engine.verify(r);await op.readProjectionControl.update({where:{projectionName:'appointments'},data:{activeGenerationId:null}});
  await assert.rejects(()=>engine.activate(r),/POINTER_CHANGED/);
  await op.readProjectionControl.update({where:{projectionName:'appointments'},data:{activeGenerationId:generation}});
  await engine.abort(r);assert.equal((await db.readProjectionGeneration.findUniqueOrThrow({where:{id:g}})).state,'RETIRED');await engine.close();mark('partial-corruption-cas-abort');
});
test('bounded table fence waits for an actual old reader to drain before snapshot',async()=>{
  const r=randomUUID(),g=randomUUID();let release,ready;const holding=new Promise(r=>release=r),acquired=new Promise(r=>ready=r);
  const reader=db.$transaction(async tx=>{await tx.appointmentReadRow.count({where:{generation}});ready();await holding;},{timeout:10000});await acquired;
  const claiming=engine.claim(r,g);
  try{const end=Date.now()+800;let waiting=false;while(Date.now()<end){const [row]=await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE %'`;if(row.n){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.ok(waiting,'actual SQL reader drain barrier');}
  finally{release();await reader;}
  await claiming;await engine.abort(r);await engine.close();mark('bounded-reader-drain');
});
test('undrained source transaction prevents freeze; retry snapshots only after committed writer drains',async()=>{
  const r=randomUUID(),g=randomUUID();let ready,release;const acquired=new Promise(r=>ready=r),held=new Promise(r=>release=r);
  const a=await db.appointment.findFirstOrThrow();const writer=db.$transaction(async tx=>{await tx.appointment.update({where:{id:a.id},data:{serviceName:'Before freeze'}});ready();await held;await recordAppointmentChange(tx,a.id);},{timeout:15000});await acquired;
  try{await assert.rejects(()=>engine.claim(r,g),/OPERATOR_BUSY/);}finally{release();await writer;}
  await engine.claim(r,g);while(!(await engine.batch(r)).done){}await engine.verify(r);await engine.activate(r);await engine.close();generation=g;mark('drain-fence');
});
test('source drift on interrupted run refuses resume and explicit abort safely releases fence',async()=>{
  const r=randomUUID(),g=randomUUID();await engine.claim(r,g);await engine.batch(r,12);
  const a=await op.appointment.findFirstOrThrow();await op.$transaction(async tx=>{await tx.appointment.update({where:{id:a.id},data:{serviceName:'Operator drift'}});await recordAppointmentChange(tx,a.id);});
  await engine.close();assert.throws(()=>cli('--resume',r,g));assert.equal(cli('--abort',r,g).status,'ABORTED');
  // Catch up the active generation using the preserved committed outbox event.
  await new AppointmentProjector(db).apply(JSON.stringify(await eventFor(a.id)));mark('drift-abort-no-reset');
});
test('generation switch, tombstone and late broker replay preserve latest source and per-generation inbox',async()=>{
  const a=await db.appointment.findFirstOrThrow({where:{reservations:{none:{}}}});await mutate(a.id,{serviceName:'Before switch'});const oldEvent=await eventFor(a.id);
  await new AppointmentProjector(db).apply(JSON.stringify(oldEvent));const oldGeneration=generation;
  const r=randomUUID(),g=randomUUID();assert.equal(cli('--run',r,g).status,'COMPLETE');generation=g;
  await mutate(a.id,{serviceName:'After switch'});const current=await eventFor(a.id);
  const projector=new AppointmentProjector(db),consumer=await consumeEvents(broker,routes.clinicRead,'clinic-read-v1',raw=>projector.apply(raw));
  try{for(const event of [current,oldEvent,oldEvent])await publishConfirmed(ch,routes.exchange,event.eventType,Buffer.from(JSON.stringify(event)),{messageId:event.eventId});
    const until=Date.now()+10000;while((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation,appointmentId:a.id}}})).serviceName!=='After switch'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,25));}
  }finally{await consumer.close();}
  assert.equal((await db.appointmentReadRow.findUniqueOrThrow({where:{generation_appointmentId:{generation:oldGeneration,appointmentId:a.id}}})).serviceName,'Before switch');
  assert.ok(await db.inboxEvent.findUnique({where:{consumerName_eventId:{consumerName:'clinic-read-v1:'+generation,eventId:current.eventId}}}));
  await db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;await tx.appointment.delete({where:{id:a.id}});await recordAppointmentChange(tx,a.id,{deleted:true});});
  await projector.apply(JSON.stringify(await eventFor(a.id)));await projector.apply(JSON.stringify(oldEvent));
  const r2=randomUUID(),g2=randomUUID();cli('--run',r2,g2);generation=g2;await projector.apply(JSON.stringify(oldEvent));
  assert.equal(await db.appointmentReadRow.count({where:{generation,appointmentId:a.id}}),0);assert.equal((await db.clinicReadRevision.findUniqueOrThrow({where:{kind_aggregateId:{kind:'appointment',aggregateId:a.id}}})).deleted,true);mark('switch-late-replay-tombstone');
});
test('source owner/existence guards every projected item/count/calendar even while projection is stale',async()=>{
  const a=await db.appointment.findFirstOrThrow({where:{ownerId:owners[0],reservations:{none:{}}}}),projected=new ProjectedAppointmentQueries(db,generation);
  await mutate(a.id,{ownerId:owners[1],petId:pets[1].id});
  const response=await projected.list(actors[0],directory(actors[0]),{id:a.id});assert.equal(response.pagination.total,0);assert.equal(response.items.length,0);assert.equal(response.counts.billingHeld,0);
  const calendar=await projected.calendar(actors[0],{month:'2028-02'});assert.deepEqual(calendar,await sourceReader.calendar(actors[0],{month:'2028-02'}));
  await new AppointmentProjector(db).apply(JSON.stringify(await eventFor(a.id)));mark('stale-owner-scope');
});
test('shadow returns authoritative on lag/corruption/outage, bounded sampling and no sensitive logs',async()=>{
  const reports=[],shadow=new ShadowAppointmentQueries(sourceReader,db,1,r=>reports.push(r)),actor=actors[2];
  const q={pageSize:'100'};assert.deepEqual(json(await shadow.list(actor,directory(actor),q)),json(await sourceReader.list(actor,directory(actor),q)));await shadow.drain();assert.equal(reports.at(-1).result,'match');
  const a=await db.appointment.findFirstOrThrow({orderBy:[{status:'asc'},{createdAt:'desc'},{id:'desc'}]});await mutate(a.id,{serviceName:'Pending event'});
  await shadow.list(actor,directory(actor),q);await shadow.drain();assert.equal(reports.at(-1).result,'lag');
  const other=await db.appointmentReadRow.findFirstOrThrow({where:{generation,appointmentId:{not:a.id},status:'pending'}});
  await db.appointmentReadRow.update({where:{generation_appointmentId:{generation,appointmentId:other.appointmentId}},data:{internalNote:'CORRUPTED_Q3_PRIVATE'}});
  await shadow.list(actor,directory(actor),q);await shadow.drain();assert.equal(reports.at(-1).result,'mismatch');
  await db.appointmentReadRow.update({where:{generation_appointmentId:{generation,appointmentId:other.appointmentId}},data:{internalNote:other.internalNote}});await new AppointmentProjector(db).apply(JSON.stringify(await eventFor(a.id)));
  await Promise.all(Array.from({length:8},()=>shadow.calendar(actor,{month:'2028-02'})));await shadow.drain();assert.ok(shadow.stats.skipped>0);
  await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{activeGenerationId:null}});
  assert.deepEqual(await shadow.calendar(actor,{month:'2028-02'}),await sourceReader.calendar(actor,{month:'2028-02'}));await shadow.drain();assert.equal(reports.at(-1).result,'unavailable');
  await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{activeGenerationId:generation}});
  let release,locked;const hold=new Promise(r=>release=r),ready=new Promise(r=>locked=r);
  const blocker=db.$transaction(async tx=>{await tx.$executeRawUnsafe('LOCK TABLE "AppointmentReadRow" IN ACCESS EXCLUSIVE MODE');locked();await hold;},{timeout:10000});await ready;
  try{await shadow.calendar(actor,{month:'2028-02'});await shadow.drain();assert.equal(reports.at(-1).result,'error');}finally{release();await blocker;}
  assert.ok(!/Q3_PRIVATE|ownerNote|internalNote|Pending event|Bearer/.test(JSON.stringify(reports)));mark('shadow-budget-lag-corruption-outage',{reports:reports.length});
});
test('HTTP shadow preserves authorization failures, owner redaction and authoritative response',async()=>{
  const old=process.env.CLINIC_READ_MODE,oldEvery=process.env.CLINIC_SHADOW_EVERY;process.env.CLINIC_READ_MODE='shadow';process.env.CLINIC_SHADOW_EVERY='1';let calls=0;
  const source={acceptsService:()=>true,request:async(actor,_token,ids)=>{calls++;if(actor.sub==='revoked')throw new Error('Core denied');if(actor.role==='owner'&&(ids.petIds??[]).some(id=>pets.find(p=>p.id===id)?.ownerId!==actor.sub)){const {BusinessError}=await import('../../../services/clinic/dist/domain/error.js');throw new BusinessError(403,'Denied');}return {...await directory(actor).lookup((ids.petIds??[]),ids.ownerIds??[]),actor:{...actor,fullName:'Fixture'}};}};
  const app=createApp(db,token=>{if(token==='revoked')return{sub:'revoked',role:'owner'};if(token!=='owner')throw new Error('Invalid');return actors[0];},source);
  if(old===undefined)delete process.env.CLINIC_READ_MODE;else process.env.CLINIC_READ_MODE=old;if(oldEvery===undefined)delete process.env.CLINIC_SHADOW_EVERY;else process.env.CLINIC_SHADOW_EVERY=oldEvery;
  server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/api/appointments')).status,401);assert.equal(calls,0);
  const denied=await fetch(base+'/api/appointments?petId='+pets[1].id,{headers:{Authorization:'Bearer owner'}});assert.equal(denied.status,403);
  const revoked=await fetch(base+'/api/appointments',{headers:{Authorization:'Bearer revoked'}});assert.equal(revoked.status,503);
  const res=await fetch(base+'/api/appointments',{headers:{Authorization:'Bearer owner'}});assert.equal(res.status,200);const value=await res.json();assert.deepEqual(value,json(await sourceReader.list(actors[0],directory(actors[0]),{})));assert.ok(value.items.every(a=>a.ownerId===owners[0]&&!('internalNote'in a)));
  await app.locals.appointmentShadow.drain();server.closeAllConnections();await new Promise(r=>server.close(r));server=undefined;mark('http-shadow-auth-redaction');
});
test('paired snapshot comparison stays consistent across a concurrent committed source update and projector catch-up',async()=>{
  const actor=actors[2],a=await db.appointment.findFirstOrThrow({orderBy:[{status:'asc'},{createdAt:'desc'},{id:'desc'}]});
  await db.$transaction(async tx=>{
    const snapshot=snapshotDatabase(tx),source=new AuthoritativeAppointmentQueries(snapshot),projection=new ProjectedAppointmentQueries(snapshot,generation);
    const before=await source.list(actor,directory(actor),{});
    await mutate(a.id,{serviceName:'Concurrent commit'});await new AppointmentProjector(db).apply(JSON.stringify(await eventFor(a.id)));
    assert.deepEqual(json(await projection.list(actor,directory(actor),{})),json(before));
    assert.ok(Object.values(await reconcileProjection(tx,generation)).every(n=>n===0));
  },{isolationLevel:'RepeatableRead',timeout:15000});mark('same-snapshot-concurrent-write');
});
test('100k source rebuild uses keyset checkpoints, verifies all rows and leaves old generation retained', {timeout:600000},async()=>{
  const count=await db.appointment.count(),extra=100000-count;
  await db.$executeRaw`INSERT INTO appointments (id,pet_id,owner_id,type,service_name,clinic_name,appointment_date,appointment_time,status_revision,created_at,updated_at) SELECT 'q3-large-'||lpad(i::text,8,'0'),'q3-pet-'||i,${owners[0]},'general_checkup'::"AppointmentType",'Large fixture','Trial','2028-02-29'::date,'09:00',0,now(),now() FROM generate_series(1,${extra}::int) i`;
  const r=randomUUID(),g=randomUUID(),start=performance.now();const result=cli('--run',r,g);const elapsedMs=performance.now()-start;
  assert.equal(result.status,'COMPLETE');assert.equal(await db.appointmentReadRow.count({where:{generation:g}}),100000);assert.ok(elapsedMs<600000);
  const diff=await db.$transaction(tx=>reconcileProjection(tx,g));assert.ok(Object.values(diff).every(v=>v===0));
  const projected=new ProjectedAppointmentQueries(db,g);for(const query of [{pageSize:'100'},{page:'1000',pageSize:'100'},{q:'Large fixture',status:'pending'}])assert.deepEqual(json(await projected.list(actors[0],directory(actors[0]),query)),json(await sourceReader.list(actors[0],directory(actors[0]),query)));
  assert.equal((await db.readProjectionGeneration.findUniqueOrThrow({where:{id:generation}})).state,'RETIRED');generation=g;
  mark('100k-rebuild',{rows:100000,elapsedMs});
});
