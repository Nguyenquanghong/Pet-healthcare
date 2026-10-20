// Local verification of the Q6 adoption/worker/HTTP wiring, not a load benchmark.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,openSync,closeSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import amqp from 'amqplib';
import {assertTestProject} from '../test-project.mjs';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {prepareReadModel,apiEnvironment} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {createApp} from '../../../services/clinic/dist/app.js';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
import {recordAppointmentChange} from '../../../services/clinic/dist/readRevision.js';
import {topology,publishConfirmed} from '../../../packages/messaging/dist/index.js';

if(process.argv.slice(2).join(' ')==='--help'){
  console.log('Usage: node tools/phase2/cqrs/run-benchmark-smoke.mjs --run\nRequires phase2:build and existing pet-phase2-p1-test. Creates two marked UUID schemas only in fixed Clinic trial DB; applies existing migrations, checks Q6 rebuild and real projector/HTTP A/B paths. Core/JWT fixture, not native/Kaggle load or performance acceptance. Retains evidence/schema/queues.');process.exit(0);
}
assert.deepEqual(process.argv.slice(2),['--run']);
const output=resolve('test-results/phase2/cqrs/q6-smoke-'+randomUUID());mkdirSync(output,{recursive:true});
const report={status:'STARTING',trials:[],cases:[],scope:'Q6 local adapter: PG/Rabbit/projector/HTTP; Core/JWT fixture, not load benchmark',capacityAccepted:false};
const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,seconds=15){const end=Date.now()+seconds*1000;while(Date.now()<end){if(await fn())return;await delay(50);}throw new Error(label);}
let stage='trial-project-guard';
try{
  assertTestProject();
  for(const mode of ['A','B']){
    const run=randomUUID(),schema='cqrs_q6_'+run.replaceAll('-',''),prefix='p2.cqrs-q6.'+run;
    const context={kind:'cqrs-q6-local-v1',run};
    report.trials.push({mode,run,schema,prefix});
    writeFileSync(resolve(output,mode+'-context.json'),JSON.stringify({...context,schema,prefix}),{mode:0o600});
    const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',schema);url.searchParams.set('connection_limit','1');
    const db=new PrismaClient({datasourceUrl:url.href});let freshness,server,worker,conn,ch;
    try{
      stage=mode+'-marker';
      assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
      assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
      assert.equal((await db.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${schema}`).length,0);
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await db.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS 'cqrs-q6:${run}'`);
      stage=mode+'-migration';
      execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
      stage=mode+'-fixture';
      const actor={sub:randomUUID(),role:'owner'},pet={id:randomUUID(),ownerId:actor.sub,name:'Synthetic Q6 pet',directoryVersion:1};
      const a=await db.appointment.create({data:{id:randomUUID(),ownerId:actor.sub,petId:pet.id,type:'general_checkup',serviceName:'Synthetic Q6 visit',clinicName:'Synthetic Q6 clinic',appointmentDate:new Date('2028-02-01'),appointmentTime:'09:00'}});
      stage=mode+'-rebuild';
      const prepared=await prepareReadModel(mode,url.href,context);
      assert.equal(prepared.rebuild.appointments,1);assert.ok(Object.values(prepared.rebuild.diff).every(n=>n===0));
      await assert.rejects(prepareReadModel(mode,url.href,context),/Q6_FRESH_TRIAL_REQUIRED/);
      const env={...apiEnvironment(mode,randomUUID()+randomUUID()),BROKER_URL:broker,BROKER_PREFIX:prefix};
      Object.assign(process.env,env);
      const fd=openSync(resolve(output,mode+'-worker.log'),'w');
      const clean=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
      worker=spawn(process.execPath,['services/clinic/dist/readWorker.js'],{env:{...clean,DATABASE_URL:url.href,BROKER_URL:broker,BROKER_PREFIX:prefix,CLINIC_READ_PROJECTOR_POOL_LIMIT:'1'},stdio:['ignore',fd,fd,'ipc']});closeSync(fd);
      stage=mode+'-worker';
      await until(()=>{assert.equal(worker.exitCode,null);return readFileSync(resolve(output,mode+'-worker.log'),'utf8').includes('worker-ready');},'Q6_WORKER_READY');
      freshness=new ReadFreshness(db);await freshness.sample();assert.ok(freshness.usable(prepared.generation));
      const directory={acceptsService:()=>true,request:async()=>({actor:{...actor,fullName:'Synthetic owner'},pets:[pet],owners:[{id:actor.sub,fullName:'Synthetic owner',directoryVersion:1}]})};
      const app=createApp(db,()=>actor,directory,undefined,freshness);
      server=app.listen(0,'127.0.0.1');await once(server,'listening');
      stage=mode+'-http';
      const base='http://127.0.0.1:'+server.address().port;
      for(const path of ['/api/appointments','/api/appointments/calendar?month=2028-02']){
        const response=await fetch(base+path,{headers:{Authorization:'Bearer synthetic-q6'}});
        assert.equal(response.status,200);assert.equal(response.headers.get('x-clinic-read-source'),prepared.readMode);
        if(mode==='B')assert.equal(response.headers.get('x-clinic-projection-generation'),prepared.generation);
        const body=await response.json();if(path.includes('calendar'))assert.equal(body['2028-02-01'],1);else assert.equal(body.items[0].id,a.id);
      }
      stage=mode+'-committed-change';
      const changed=await db.$transaction(async tx=>{
        await tx.$queryRaw`SELECT id FROM appointments WHERE id=${a.id} FOR UPDATE`;
        await tx.appointment.update({where:{id:a.id},data:{status:'confirmed'}});
        return recordAppointmentChange(tx,a.id);
      });
      const row=await db.outboxEvent.findUniqueOrThrow({where:{id:changed.eventId}});
      conn=await amqp.connect(broker);ch=await conn.createConfirmChannel();
      await publishConfirmed(ch,topology(prefix).exchange,'clinic.appointment-read-changed.v1',Buffer.from(JSON.stringify(row.envelope)),{messageId:row.id,persistent:true});
      await until(async()=>await db.appointmentReadRow.count({where:{generation:prepared.generation,appointmentId:a.id,sourceVersion:2,status:'confirmed'}})===1,'Q6_PROJECTOR_CATCHUP');
      await freshness.sample();
      const read=await fetch(base+'/api/appointments',{headers:{Authorization:'Bearer synthetic-q6'}});
      assert.equal(read.headers.get('x-clinic-read-source'),prepared.readMode);assert.equal((await read.json()).items[0].status,'confirmed');
      report.cases.push({mode,run,schema,prefix,status:'PASS',rebuild:prepared.rebuild,readMode:prepared.readMode,projectorAppliedVersion:2});
    }finally{
      if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
      await freshness?.close();await ch?.close();await conn?.close();
      try{if(worker){if(worker.exitCode===null){worker.send({type:'shutdown'});try{await until(()=>worker.exitCode!==null,'Q6_DRAIN',20);}catch(error){worker.kill('SIGKILL');throw error;}}assert.equal(worker.exitCode,0);}}
      finally{await db.$disconnect();}
    }
  }
  report.status='PASS';
}catch(error){report.status='FAIL';report.failedStage=stage;report.errorType=error.name;process.exitCode=1;}
finally{writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output}));}
