import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {AppointmentAggregateCache} from '../../../services/clinic/dist/infrastructure/queries/appointmentAggregateCache.js';
import {ProjectedAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';
import {AuthoritativeAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/authoritativeAppointments.js';
import {ServingAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/servingAppointments.js';
import {snapshotDatabase,responseHash} from '../../../services/clinic/dist/infrastructure/queries/shadowAppointments.js';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
import {createApp} from '../../../services/clinic/dist/app.js';
import {BusinessError} from '../../../services/clinic/dist/domain/error.js';
import {ReadTokens} from '../../../services/clinic/dist/readToken.js';
import {once} from 'node:events';
import {ReadDiagnostics} from '../../../services/clinic/dist/readDiagnostics.js';

export async function verifyAggregateCache(db,url,context,output,privilegedSql,options={}){
 assert.ok(options.parallelWorkers===undefined||options.parallelWorkers===1);
 assert.ok(options.freshnessWorkers===undefined||options.freshnessWorkers===0);
 const rounds=options.coldRounds===undefined?[false,true,true,false]:Array(options.coldRounds).fill(true);
 assert.ok(options.coldRounds===undefined||Number.isInteger(options.coldRounds)&&options.coldRounds>=2&&options.coldRounds<=10);
 const requests=options.coldRounds===undefined?360:60;
 await guard(db,url,context);
 const report={status:'STARTING',scope:'real PG + synthetic directory/broker health, not HTTP/native acceptance',capacityAccepted:false,cases:[],loads:[]};
 const save=()=>writeFileSync(resolve(output,'aggregate-cache.json'),JSON.stringify(report,null,2));
 const mark=name=>{report.cases.push(name);console.log('Cache check: '+name);save();};
 const c=await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}}),generation=c.activeGenerationId;
 const records=await db.directoryProjection.findMany(),pets=records.filter(r=>r.kind==='pet').map(r=>({id:r.id,ownerId:r.ownerId,name:r.displayName,directoryVersion:1})),owners=records.filter(r=>r.kind==='owner').map(r=>({id:r.id,fullName:r.displayName,directoryVersion:1}));
 const directory={lookup:async(pids,oids)=>({pets:pets.filter(p=>pids.includes(p.id)),owners:owners.filter(o=>oids.includes(o.id))}),pet:async id=>pets.find(p=>p.id===id)};
 const owner={role:'owner',sub:pets[0].ownerId},other={role:'owner',sub:pets[1].ownerId},admin={role:'admin',sub:context.run};
 const apiUrl=new URL(url.href);apiUrl.searchParams.set('connection_limit','4');const api=new PrismaClient({datasourceUrl:apiUrl.href});
 const cache=new AppointmentAggregateCache(()=>performance.now(),128,5000);
 const read=(work,store=cache)=>api.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   return work(new ProjectedAppointmentQueries(snapshotDatabase(tx),generation,undefined,store));
 },{isolationLevel:'RepeatableRead',timeout:10000});
 // Explicit null to avoid a default-parameter cache on the control path.
 const direct=work=>api.$transaction(async tx=>work(new ProjectedAppointmentQueries(snapshotDatabase(tx),generation)),{isolationLevel:'RepeatableRead',timeout:10000});
 const compare=async work=>{const expected=await direct(work),actual=await read(work);assert.equal(responseHash(actual),responseHash(expected));return actual;};
 const epochs=()=>db.$queryRaw`SELECT scope,revision::text AS revision FROM "AppointmentQueryEpoch" ORDER BY scope`;
 let freshness;
 try{
  // Complete response parity and actor/filter/generation partitioning.
  for(const actor of [owner,other,admin])for(const query of [{},{page:'500',pageSize:'100'},{status:'completed'},{category:'spa',date:'2028-02-01'},{q:'M\u00e8o'},{q:'no-match'},{petId:pets[0].id},{ownerId:pets[1].ownerId}]){
   const work=r=>r.list(actor,directory,query),first=await compare(work);assert.equal(responseHash(await read(work)),responseHash(first));assert.equal(responseHash(first),responseHash(await work(new AuthoritativeAppointmentQueries(api))));
  }
  for(const actor of [owner,other,admin])for(const category of [undefined,'spa','medical']){const work=r=>r.calendar(actor,{month:'2028-02',category});assert.equal(responseHash(await compare(work)),responseHash(await work(new AuthoritativeAppointmentQueries(api))));}
  assert.ok(cache.stats.hits>=24);mark('33 full response parity cases + repeated cache hits and actor/filter isolation');
  const row=await db.appointment.findFirstOrThrow({where:{ownerId:owner.sub,reservations:{none:{}},medicalRecords:{none:{}}}}),list=r=>r.list(owner,directory,{id:row.id}),calendar=r=>r.calendar(owner,{month:'2028-02'});
  await read(list);await read(calendar);
  // Populate the shared admin cube before each ACL/projection change. The
  // cached and uncached broad reader must agree after each epoch invalidation.
  const adminCube=async()=>{await compare(r=>r.list(admin,directory,{}));await compare(r=>r.list(admin,directory,{category:'spa',date:'2028-02-01'}));await compare(r=>r.calendar(admin,{month:'2028-02'}));};
  await adminCube();

  // Committed source ACL changes must fence stale projection immediately.
  await db.appointment.update({where:{id:row.id},data:{ownerId:other.sub}});
  assert.equal((await compare(list)).pagination.total,0);await compare(calendar);await adminCube();
  assert.equal((await compare(r=>r.list(other,directory,{id:row.id}))).pagination.total,0);
  await db.appointment.update({where:{id:row.id},data:{ownerId:row.ownerId,petId:randomUUID()}});
  assert.equal((await compare(list)).pagination.total,0);await compare(calendar);await adminCube();
  await db.appointment.update({where:{id:row.id},data:{petId:row.petId}});assert.equal((await compare(list)).pagination.total,1);
  await db.appointment.delete({where:{id:row.id}});assert.equal((await compare(list)).pagination.total,0);await compare(calendar);await adminCube();
  await db.appointment.create({data:row});assert.equal((await compare(list)).pagination.total,1);mark('committed owner/pet reassignment, deletion and recreation invalidate cached counts/calendar');
  // Projection mutations (including fields that are not statusRevision) and directory search.
  const key={generation_appointmentId:{generation,appointmentId:row.id}},projected=await db.appointmentReadRow.findUniqueOrThrow({where:key});
  await db.appointmentReadRow.update({where:key,data:{billingHeld:!projected.billingHeld,appointmentDate:new Date('2028-03-01')}});await compare(list);await compare(calendar);await adminCube();
  await db.appointmentReadRow.update({where:key,data:{deletedAt:new Date()}});assert.equal((await compare(list)).pagination.total,0);
  await db.appointmentReadRow.update({where:key,data:{billingHeld:projected.billingHeld,appointmentDate:projected.appointmentDate,deletedAt:projected.deletedAt}});
  const search=r=>r.list(owner,directory,{q:'cache-unique-pet-name'});assert.equal((await compare(search)).pagination.total,0);
  const pet=records.find(r=>r.kind==='pet'&&r.id===row.petId);await db.directoryProjection.update({where:{kind_id:{kind:'pet',id:row.petId}},data:{displayName:'cache-unique-pet-name'}});
  assert.ok((await compare(search)).pagination.total>0);await db.directoryProjection.update({where:{kind_id:{kind:'pet',id:row.petId}},data:{displayName:pet.displayName}});assert.equal((await compare(search)).pagination.total,0);
  mark('projection billing/date/tombstone and directory rename invalidate without statusRevision assumptions');
  const before=await epochs();
  await assert.rejects(db.$transaction(async tx=>{await tx.appointment.update({where:{id:row.id},data:{ownerId:other.sub}});await tx.appointmentReadRow.update({where:key,data:{billingHeld:!projected.billingHeld}});throw new Error('TRIAL_ROLLBACK');}),/TRIAL_ROLLBACK/);
  assert.deepEqual(await epochs(),before);assert.equal((await compare(list)).pagination.total,1);
  // Writable transactions cannot populate cache with a revision that might roll back/recur.
  await assert.rejects(db.$transaction(tx=>new ProjectedAppointmentQueries(snapshotDatabase(tx),generation,undefined,cache).calendar(owner,{month:'2028-02'}),{isolationLevel:'RepeatableRead'}),/EPOCH_UNAVAILABLE/);
  mark('rollback is atomic; writable snapshot cannot poison cache with an uncommitted revision');
  // Snapshot starts before concurrent ACL commit: it retains the old correct
  // snapshot, while the next request MUST observe the new epoch and deny row.
  await read(list);let entered,release;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  const concurrent=api.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$queryRaw`SELECT count(*) FROM "AppointmentQueryEpoch"`;entered();await held;
   return new ProjectedAppointmentQueries(snapshotDatabase(tx),generation,undefined,cache).list(owner,directory,{id:row.id});
  },{isolationLevel:'RepeatableRead',timeout:10000});
  await ready;
  try{await db.appointment.update({where:{id:row.id},data:{ownerId:other.sub}});}finally{release();}
  assert.equal((await concurrent).pagination.total,1);assert.equal((await compare(list)).pagination.total,0);
  await db.appointment.update({where:{id:row.id},data:{ownerId:row.ownerId,updatedAt:row.updatedAt}});mark('concurrent ACL commit respects old RepeatableRead snapshot and invalidates next request');
  // Security-definer trigger: a projector-like role cannot mutate epochs itself,
  // but its permitted projection write still invalidates cache atomically.
  const role='cache_'+randomUUID().replaceAll('-','');assert.match(role,/^cache_[0-9a-f]{32}$/);
  privilegedSql(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; GRANT ${role} TO p8_clinic; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,UPDATE ON "AppointmentReadRow" TO ${role}; GRANT SELECT ON "ReadRebuildRun" TO ${role};`);
  const priorRoleEpochs=await epochs();
  await db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL ROLE '+role);await tx.appointmentReadRow.update({where:key,data:{billingHeld:!projected.billingHeld}});});
  assert.notDeepEqual(await epochs(),priorRoleEpochs);await compare(list);
  await assert.rejects(db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL ROLE '+role);await tx.$executeRawUnsafe('UPDATE "AppointmentQueryEpoch" SET revision=1');}),e=>e.meta?.code==='42501');
  await db.appointmentReadRow.update({where:key,data:{billingHeld:projected.billingHeld}});mark('restricted projector can trigger invalidation but cannot update epoch guard');
  const canonical=new AuthoritativeAppointmentQueries(api);
  for(const work of [list,calendar,r=>r.list(admin,directory,{page:'500',pageSize:'100'}),r=>r.list(admin,directory,{q:'M\u00e8o'})])assert.equal(responseHash(await read(work)),responseHash(await work(canonical)));
  mark('restored fixture matches authoritative response');
  // Real HTTP composition, synthetic Core authorization dependency. A populated
  // aggregate cache must not skip Core, token checks, redaction or freshness.
  const secret='cache-trial-'+randomUUID(),previousMode=process.env.CLINIC_READ_MODE,previousSecret=process.env.CLINIC_READ_TOKEN_SECRET;
  process.env.CLINIC_READ_MODE='projection';process.env.CLINIC_READ_TOKEN_SECRET=secret;
  let denied=false;const actors={owner,other,admin},httpFreshness=new ReadFreshness(db,async()=>true);await httpFreshness.sample();assert.ok(httpFreshness.usable(generation));
  const core={acceptsService:()=>true,request:async(actor,_token,ids)=>{
   if(denied)throw new BusinessError(403,'Trial revocation');
   if(actor.role==='owner'&&(ids.petIds??[]).some(id=>pets.find(p=>p.id===id)?.ownerId!==actor.sub))throw new BusinessError(403,'Denied');
   return {actor:{...actor,fullName:'Trial'},...await directory.lookup(ids.petIds??[],ids.ownerIds??[])};
  }};
  const app=createApp(api,t=>{if(!actors[t])throw new Error('Invalid token');return actors[t];},core,undefined,httpFreshness),server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const get=async(headers={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/appointments?id='+row.id,{headers:{Authorization:'Bearer owner',...headers}});return {status:r.status,data:await r.json(),source:r.headers.get('x-clinic-read-source')};};
  try{
   assert.equal((await get()).source,'projection');const hit=await get();assert.equal(hit.source,'projection');assert.ok(!('internalNote' in hit.data.items[0]));
   denied=true;assert.equal((await get()).status,403);denied=false;
   assert.equal((await get({'X-Clinic-Min-Version':'forged'})).status,422);
   const token=new ReadTokens(secret).issue(owner,{[row.id]:2});assert.equal((await get({'X-Clinic-Min-Version':token})).source,'authoritative');
   httpFreshness.evidence=undefined;assert.equal((await get()).source,'authoritative');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await httpFreshness.close();if(previousMode===undefined)delete process.env.CLINIC_READ_MODE;else process.env.CLINIC_READ_MODE=previousMode;if(previousSecret===undefined)delete process.env.CLINIC_READ_TOKEN_SECRET;else process.env.CLINIC_READ_TOKEN_SECRET=previousSecret;}
  mark('HTTP cache hits preserve Core revocation, owner redaction, forged/RYW tokens and freshness fallback');
  const operations=[['owner-list',r=>r.list(owner,directory,{})],['admin-list',r=>r.list(admin,directory,{pageSize:'100'})],['admin-search',r=>r.list(admin,directory,{q:'M\u00e8o',pageSize:'100'})],['admin-unbilled',r=>r.list(admin,directory,{mode:'unbilled'})],['owner-calendar',r=>r.calendar(owner,{month:'2028-02'})],['admin-calendar',r=>r.calendar(admin,{month:'2028-02'})],['admin-filter',r=>r.list(admin,directory,{category:'spa',statusGroup:'pending',date:'2028-02-01'})],['admin-page',r=>r.list(admin,directory,{page:'500',pageSize:'100'})]];
  // ABBA, cold per-process caches for each round, unchanged 12/s, pool4,
  // concurrency16 and serving budgets; real freshness SQL on separate pool1.
  for(const enabled of rounds){
   console.log('Load round: '+(enabled?'cache':'no-cache'));const store=enabled?new AppointmentAggregateCache():null;
   const events=[],diagnostics=new ReadDiagnostics(true,line=>events.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))));
   const freshnessDb=options.freshnessWorkers===0?new Proxy(db,{get(t,key){
    if(key==='$transaction')return (work,settings)=>t.$transaction(async tx=>{await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');return work(tx);},settings);
    const value=Reflect.get(t,key);return typeof value==='function'?value.bind(t):value;
   }}):db;
   freshness=new ReadFreshness(freshnessDb,async()=>true,undefined,diagnostics);await freshness.sample();assert.ok(freshness.usable(generation));freshness.start();
   // Cold rounds cover different offsets against the 2s background audit.
   // No aggregate is primed during this delay; keep every first request.
   const freshnessOffsetMs=options.coldRounds===undefined?0:(report.loads.length%5)*350;
   if(freshnessOffsetMs)await delay(freshnessOffsetMs);
   function instrument(target){return new Proxy(target,{get(t,key){
    if(key==='$transaction')return (work,settings)=>t.$transaction(tx=>work(instrument(tx)),settings);
    if(key==='$executeRawUnsafe')return async(sql,...values)=>{if(sql==="SET LOCAL plan_cache_mode='force_custom_plan'")await t.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=1');return t.$executeRawUnsafe(sql,...values);};
    const value=Reflect.get(t,key);return typeof value==='function'?value.bind(t):value;
   }});}
   const serving=new ServingAppointmentQueries(enabled&&options.parallelWorkers===1?instrument(api):api,freshness,diagnostics,store),rows=[],active=new Set(),start=performance.now();
   for(let i=0;i<requests;i++){
    await delay(Math.max(0,start+i*1000/12-performance.now()));const [operation,run]=operations[i%8],entry={sequence:i,operation};rows.push(entry);
    if(active.size>=16){entry.error='GENERATOR_DROP';continue;}
    const task=(async()=>{const t=performance.now();try{entry.source=(await diagnostics.run(operation,()=>serving.read(run,{},operation==='admin-unbilled'))).source;}catch(e){entry.error=/^P\d{4}$/.test(e.code??'')?e.code:'READ_ERROR';}entry.ms=performance.now()-t;})();active.add(task);task.finally(()=>active.delete(task));
   }
   await Promise.all(active);await freshness.close();freshness=undefined;
   const good=rows.filter(r=>!r.error&&r.source===(r.operation==='admin-unbilled'?'authoritative':'projection')).length;
   const summaries=operations.map(([operation])=>{const times=rows.filter(r=>r.operation===operation).map(r=>r.ms).filter(Number.isFinite).sort((a,b)=>a-b);return {operation,n:times.length,p95Ms:times[Math.ceil(times.length*.95)-1],maxMs:times.at(-1)};});
   report.loads.push({cache:enabled,freshnessOffsetMs,parallelWorkers:enabled?options.parallelWorkers??null:null,freshnessWorkers:options.freshnessWorkers??null,correctSource:good,total:rows.length,cacheStats:store?.stats,servingStats:serving.stats,summaries,events,rows});save();console.log(JSON.stringify({cache:enabled,correctSource:good,total:rows.length}));
  }
  report.status='PASS';report.cachedLoad=report.loads.filter(r=>r.cache).every(r=>r.correctSource===r.total)?'PASS':'FAIL';save();return report;
 }catch(error){report.status='FAIL';report.errorType=error.name;report.errorCode=error.code;save();throw error;}
 finally{await freshness?.close();await api.$disconnect();}
}
