import assert from 'node:assert/strict';
import {context,client,guard} from './q3-trial.mjs';
import {AppointmentRebuild} from '../../../services/clinic/dist/readRebuild.js';
const args=process.argv.slice(2),version=args.at(-1)==='--schema-version=2'?args.pop()&&2:1;
const [command,file,run,generation,...extra]=args;
if(command==='--help'){console.log('Usage: node tools/phase2/cqrs/rebuild.mjs --dry-run <Q3-context.json> | --run|--resume|--abort <context> <run-UUID> <generation-UUID> [--schema-version=2]\nOnly marked local Q3 schemas; fixed trial DB/broker, no ambient .env. Stop trial Clinic/projector consumers first. Dry-run writes nothing. Run/resume installs a durable SQL write fence, checkpoints batches, reconciles and switches ACTIVE with authoritative serving. Crash retains fence: resume or explicitly abort. No purge or generation deletion.');process.exit(0);}
assert.ok(['--dry-run','--run','--resume','--abort'].includes(command));assert.equal(extra.length,0);assert.ok(file);
if(command==='--dry-run')assert.ok(!run&&!generation);else assert.ok(run&&generation);
const c=context(file),db=client(c),engine=new AppointmentRebuild(db);
try{
  await guard(db,c,{workersStopped:command!=='--dry-run'});
  if(command==='--dry-run'){const [size]=await db.$queryRaw`SELECT pg_total_relation_size('appointments')::text AS "sourceBytes",pg_total_relation_size('"AppointmentReadRow"')::text AS "readBytes"`;console.log(JSON.stringify({status:'DRY_RUN',...await engine.inspect(),...size,mutation:false}));}
  else{
    if(command==='--resume')assert.ok(await db.readRebuildRun.findUnique({where:{id:run}}),'Q3_RESUME_RUN_MISSING');
    if(command==='--run')assert.equal(await db.readRebuildRun.findUnique({where:{id:run}}),null,'Q3_USE_RESUME');
    await engine.claim(run,generation,{abortOnly:command==='--abort',schemaVersion:version});
    if(command==='--abort'){await engine.abort(run);console.log(JSON.stringify({status:'ABORTED',run,generation,servingMode:'authoritative'}));}
    else{
      // V2: rows first, then one canonical summary replacement; never both paths.
      if((await db.readRebuildRun.findUniqueOrThrow({where:{id:run}})).state==='BUILDING'){while(!(await engine.batch(run)).done){}if(version===2)await engine.summarize(run);}
      const diff=await engine.verify(run);const result=await engine.activate(run);
      console.log(JSON.stringify({status:'COMPLETE',run,...result,diff}));
    }
  }
}catch(error){const code=/^(REBUILD_[A-Z_]+|Q3_[A-Z_]+|INVALID_REBUILD_ID)$/.test(error.message)?error.message:'Q3_REBUILD_FAILED_INSPECT_TRIAL';console.error(JSON.stringify({status:'FAILED',code,fenceMayRemain:true}));process.exitCode=1;}
finally{await engine.close().catch(()=>{});await db.$disconnect();}
