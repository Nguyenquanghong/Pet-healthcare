// Crash process for the guarded D3 rebuild cases only. Claims/resumes one V2 run
// with a private single-connection operator, advances to a stage, reports it and
// waits to be SIGKILLed while still owning the durable fence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {AppointmentRebuild} from '../../../../services/clinic/dist/readRebuild.js';
const c=JSON.parse(readFileSync(process.env.ACTIVITY_D3_CONTEXT,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.schema,'activity_d3_'+hex);assert.equal(c.marker,'clinic-activity-d3:'+c.run);
const [mode,run,generation]=process.argv.slice(2);assert.ok(['after-batch','after-summary','after-verify'].includes(mode));
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','1');
const db=new PrismaClient({datasourceUrl:url.href}),engine=new AppointmentRebuild(db);
try{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  const [scope]=await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`;assert.equal(scope.marker,c.marker);
  await engine.claim(run,generation,{schemaVersion:2});
  if(mode==='after-batch')await engine.batch(run,2000);
  else{
    if((await db.readRebuildRun.findUniqueOrThrow({where:{id:run}})).state==='BUILDING'){while(!(await engine.batch(run,2000)).done){}await engine.summarize(run);}
    if(mode==='after-verify')await engine.verify(run);
  }
  process.send({stage:mode});await new Promise(()=>{});
}catch(error){process.send?.({stage:'failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'CHILD_FAILED'});await db.$disconnect();process.exitCode=1;}
