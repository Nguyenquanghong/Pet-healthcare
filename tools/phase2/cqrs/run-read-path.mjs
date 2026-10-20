import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {client} from './q4-trial.mjs';
import {assertTestProject} from '../test-project.mjs';
if(process.argv.slice(2).join(' ')==='--help'){console.log('Usage: node tools/phase2/cqrs/run-read-path.mjs --run\nBuild phase2 first. Creates a fresh marked UUID schema only in the fixed Clinic trial DB; migrates, tests Q4 projected HTTP, freshness and read tokens, retains evidence. Requires existing pet-phase2-p1-test, no Docker build/pull or main DB.');process.exit(0);}
assert.deepEqual(process.argv.slice(2),['--run']);assertTestProject();
const run=randomUUID(),c={run,schema:'cqrs_q4_'+run.replaceAll('-',''),marker:'cqrs-q4:'+run,prefix:'p2.cqrs-q4.'+run};
const output=resolve('test-results/phase2/cqrs/q4-'+run);mkdirSync(output,{recursive:true});const file=resolve(output,'context.json');writeFileSync(file,JSON.stringify({...c,output}),{mode:0o600});
const db=client(c);let stage='identity';const report={run,schema:c.schema,status:'STARTING',output};
try{
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.equal((await db.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${c.schema}`).length,0);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${c.schema}"`);await db.$executeRawUnsafe(`COMMENT ON SCHEMA "${c.schema}" IS '${c.marker}'`);
  const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);
  stage='migrate';execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
  await db.$disconnect();stage='tests';
  execFileSync(process.execPath,['--test','--test-concurrency=1','tools/phase2/cqrs/read-path.integration.mjs'],{env:{...process.env,CQRS_Q4_CONTEXT:file},stdio:'inherit'});
  report.status='PASS';console.log(JSON.stringify(report));
}catch{report.status='FAIL';report.stage=stage;process.exitCode=1;console.error(JSON.stringify(report));}
finally{await db.$disconnect();writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));}
