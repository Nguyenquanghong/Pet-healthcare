// Q2 integration entry point. Only dedicated local trial infra and fresh schema.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertTestProject} from '../test-project.mjs';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
if(process.argv.slice(2).join(' ')==='--help'){
  console.log('Usage: node tools/phase2/cqrs/run-projector.mjs --run\nFirst run npm run phase2:build to generate clients and compile current source.\nRequires pet-phase2-p1-test. Creates marked UUID schema in p2_clinic_test, applies additive Clinic migrations and runs Q2 PG/RabbitMQ tests. Retains evidence/schema/queues, no main DB or Docker build/pull.');process.exit(0);
}
assert.deepEqual(process.argv.slice(2),['--run']);assertTestProject();
const run=randomUUID(),schema='cqrs_q2_'+run.replaceAll('-',''),marker='cqrs-q2:'+run;
const output=resolve('test-results/phase2/cqrs','q2-'+run);mkdirSync(output,{recursive:true});
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',schema);url.searchParams.set('connection_limit','6');
const db=new PrismaClient({datasourceUrl:url.href});let stage='identity';
const report={run,schema,marker,status:'STARTING',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),migrations:'NOT_RUN'};
try{
  const [identity]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;
  assert.deepEqual(identity,{db:'p2_clinic_test',role:'p2_clinic'});
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.equal((await db.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${schema}`).length,0);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);await db.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
  stage='migrations';
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
  report.migrations='APPLIED_TO_NEW_TRIAL_SCHEMA';
  await db.$disconnect();stage='tests';
  const contextPath=resolve(output,'context.json');writeFileSync(contextPath,JSON.stringify({run,schema,marker,output}),{mode:0o600});
  execFileSync(process.execPath,['--test','--test-concurrency=1','tools/phase2/cqrs/projector.integration.mjs'],
    {env:{...process.env,CQRS_Q2_CONTEXT:contextPath},stdio:'inherit'});
  report.status='PASS';console.log(JSON.stringify({run,status:'PASS',artifact:output}));
}catch(error){report.status='FAIL';report.failedStage=stage;report.error=error instanceof assert.AssertionError?error.message:error.code??error.name;process.exitCode=1;console.error(JSON.stringify({run,status:report.status,stage,error:report.error}));}
finally{await db.$disconnect();writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));}
