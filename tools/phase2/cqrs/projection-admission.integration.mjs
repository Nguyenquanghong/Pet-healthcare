import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {ServingAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/servingAppointments.js';
import {ReadDiagnostics} from '../../../services/clinic/dist/readDiagnostics.js';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
import {reconcileProjection} from '../../../services/clinic/dist/projectionSnapshot.js';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

export async function verifyProjectionAdmission(db,url,context,output){
 await guard(db,url,context);assert.equal(await db.appointment.count(),100000);
 const apiUrl=new URL(url.href);apiUrl.searchParams.set('connection_limit','4');
 const api=new PrismaClient({datasourceUrl:apiUrl.href}),events=[];
 const diagnostics=new ReadDiagnostics(true,line=>events.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))));
 const freshness=new ReadFreshness(db,async()=>true,undefined,diagnostics);
 const report={status:'STARTING',scope:'real PG queue/ACL snapshots; synthetic directory/broker health',cases:[],capacityAccepted:false};
 const save=()=>writeFileSync(resolve(output,'projection-admission.json'),JSON.stringify({...report,events},null,2));
 const control=await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'}});
 const row=await db.appointment.findFirstOrThrow(),other=await db.appointment.findFirstOrThrow({where:{ownerId:{not:row.ownerId}}});
 const records=await db.directoryProjection.findMany();
 const pets=records.filter(r=>r.kind==='pet').map(r=>({id:r.id,ownerId:r.ownerId,name:r.displayName,directoryVersion:1}));
 const owners=records.filter(r=>r.kind==='owner').map(r=>({id:r.id,fullName:r.displayName,directoryVersion:1}));
 const directory={lookup:async(pids,oids)=>({pets:pets.filter(p=>pids.includes(p.id)),owners:owners.filter(o=>oids.includes(o.id))}),pet:async id=>pets.find(p=>p.id===id)};
 const owner={role:'owner',sub:row.ownerId},admin={role:'admin',sub:context.run};
 let opened=0,active=0,maxActive=0;
 const observed=new Proxy(api,{get(t,k){
  if(k==='$transaction')return async(fn,options)=>{opened++;active++;maxActive=Math.max(maxActive,active);try{return await t.$transaction(fn,options);}finally{active--;}};
  const value=Reflect.get(t,k);return typeof value==='function'?value.bind(t):value;
 }});
 const serving=new ServingAppointmentQueries(observed,freshness,diagnostics);
 const list=r=>r.list(owner,directory,{id:row.id});
 const call=(work,versions={},forced=false)=>diagnostics.run(forced?'admin-unbilled':'owner-list',()=>serving.read(work,versions,forced));
 const held=[];
 async function hold(){
  const ready=deferred(),release=deferred();held.push(release);
  const promise=call(async reader=>{const result=await list(reader);ready.resolve();await release.promise;return result;});
  // Observe rejection immediately even if setup fails before ready is signaled.
  await Promise.race([ready.promise,promise.then(()=>{throw new Error('HOLD_NOT_ENTERED');})]);
  return {promise,release};
 }
 try{
  await freshness.sample();assert.ok(freshness.usable(control.activeGenerationId));
  assert.equal((await call(list)).data.pagination.total,1);
  const first=await hold();const before=opened;
  const queued=call(list);await new Promise(r=>setImmediate(r));assert.equal(opened,before);
  // Mutate source authorization while the second request has NO snapshot.
  try{await db.appointment.update({where:{id:row.id},data:{ownerId:other.ownerId}});}finally{first.release.resolve();}
  const [oldSnapshot,newSnapshot]=await Promise.all([first.promise,queued]);
  assert.equal(oldSnapshot.source,'projection');assert.equal(oldSnapshot.data.pagination.total,1);
  assert.equal(newSnapshot.source,'projection');assert.equal(newSnapshot.data.pagination.total,0);
  await db.appointment.update({where:{id:row.id},data:{ownerId:row.ownerId,updatedAt:row.updatedAt}});
  report.cases.push('queued request opens no transaction until granted; source ACL commit invalidates warm cache, old snapshot stays correct');save();

  const second=await hold();const controlQueue=call(list);await new Promise(r=>setImmediate(r));
  try{await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{servingMode:'authoritative'}});}finally{second.release.resolve();}
  assert.equal((await second.promise).source,'projection');assert.equal((await controlQueue).source,'authoritative');
  await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{servingMode:control.servingMode}});
  report.cases.push('control rollback to authoritative during admission is read again after grant');save();

  // A forced-source request may proceed while a projected snapshot holds its slot.
  const third=await hold();let forced;
  try{forced=await call(r=>r.list(admin,directory,{id:row.id,mode:'unbilled'}),{},true);}finally{third.release.resolve();}
  await third.promise;assert.equal(forced.source,'authoritative');assert.equal(maxActive,2);
  report.cases.push('real authoritative unbilled uses a connection independently of the held projected slot');save();

  const fourth=await hold(),beforeTimeout=opened;let timed;
  try{timed=await call(list,{[row.id]:1});}finally{fourth.release.resolve();}
  await fourth.promise;assert.equal(timed.source,'authoritative');assert.equal(opened,beforeTimeout+1);
  assert.ok(events.some(e=>e.event==='projection_failure'&&e.stage==='projection-admission'));
  assert.equal((await call(list)).source,'projection');assert.equal(opened,beforeTimeout+2);
  report.cases.push('admission timeout starts only fallback, expired waiter never runs later, next projection recovers');save();

  assert.equal(active,0);report.maxActiveIncludingForcedSource=maxActive;
  report.diff=await reconcileProjection(db,control.activeGenerationId);assert.ok(Object.values(report.diff).every(n=>n===0));
  report.sourceRows=await db.appointment.count();assert.equal(report.sourceRows,100000);
  report.status='PASS';save();return report;
 }catch(error){report.status='FAIL';report.errorType=error.name;report.errorCode=error.code;save();throw error;}
 finally{
  for(const release of held)release.resolve();
  // Restore only the exact known trial row/control fields touched above.
  await db.appointment.update({where:{id:row.id},data:{ownerId:row.ownerId,updatedAt:row.updatedAt}});
  await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{servingMode:control.servingMode}});
  await freshness.close();await api.$disconnect();
 }
}
