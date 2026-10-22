// D2 PostgreSQL entry point. Default prints help. --run only targets the dedicated
// local pet-phase2-p1-test project after identity/marker/role/schema checks.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertTestProject} from '../../test-project.mjs';
import {sql as privilegedSql} from '../../p7-environment.mjs';
import {runtimeGrantStatements} from '../../p7-cutover.mjs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';

const help=`Usage: node tools/phase2/cqrs/activity/run-summary-projector.mjs --run | --run-rebuild | --run-reader | --run-fault | --run-smoke
Build first: npm run activity:build (generated Clinic client must include migration 20261021000100).
Requires exactly the dedicated four-container pet-phase2-p1-test Compose project; this tool never
starts, builds, pulls, downs or resets it. Before any write it checks container labels/port,
current_database=p2_clinic_test, current_user=p2_clinic (not superuser), public.p2_test_marker and
that the run schema is absent. Then it creates schema activity_d2_<run> (COMMENT marker), applies
Clinic migrations to that schema only, creates two NOLOGIN run roles (projector = exact P7 clinic
runtime write grants, reader = SELECT-only) and runs D2 PG cases, then broker cases on run-scoped
queues p2.activity-d2.<run>.* of the same project (kill before commit / after commit before ACK,
built worker capability). Retains schema, roles, queues and evidence under
test-results/phase2/cqrs/activity/d2-pg-<run>/.
--run-rebuild (D3) uses the same guards with schema activity_d3_<run>, roles act_d3_*, queues
p2.activity-d3.<run>.* and runs summary-rebuild.integration.mjs (V2 rebuild 0/1/100k, crash/resume,
drift, replay, independent evidence); evidence under test-results/phase2/cqrs/activity/d3-pg-<run>/.
--run-reader (D4): schema activity_d4_<run>, D1 10k fixture, V2 rebuild, summary/source/cached parity,
real fallbacks, operator control rollback and HTTP; evidence under d4-pg-<run>/.`;
const args=process.argv.slice(2);
if(!args.length||args.join(' ')==='--help'){console.log(help);process.exit(0);}
const suites={'--run':['d2',['summary.integration.mjs','summary-broker.integration.mjs']],'--run-rebuild':['d3',['summary-rebuild.integration.mjs']],'--run-reader':['d4',['summary-reader.integration.mjs']],'--run-fault':['d5',['summary-fault.integration.mjs']],'--run-smoke':['d5s',['summary-smoke.integration.mjs']]}[args.join(' ')];
if(!suites){console.error(help);process.exit(2);}
const [suite,files]=suites;

assertTestProject();
const run=randomUUID(),hex=run.replaceAll('-',''),schema=`activity_${suite}_`+hex,marker=`clinic-activity-${suite}:`+run;
const roles={projector:`act_${suite}_p_`+hex,reader:`act_${suite}_r_`+hex};
for(const name of [schema,...Object.values(roles)])assert.match(name,/^[a-z0-9_]{1,63}$/);
const output=resolve('test-results/phase2/cqrs/activity',suite+'-pg-'+run);mkdirSync(output,{recursive:true});
// Disposable fixture credentials from deploy/phase2/init-test.sql; never printed.
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',schema);url.searchParams.set('connection_limit','4');
const migrationsDir='services/clinic/prisma/migrations',migrations=readdirSync(migrationsDir,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort();
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const report={run,suite,schema,marker,roles,status:'STARTING',startedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  migration:{name:'20261021000100_appointment_daily_summary_v2',sha256:sha(migrationsDir+'/20261021000100_appointment_daily_summary_v2/migration.sql')},
  policySha256:sha('phase2-plan/cqrs/clinic-activity/acceptance.frozen.json'),migrations:'NOT_RUN',scope:'real PostgreSQL transactions/locks/grants + real RabbitMQ redelivery/ACK on run-scoped queues'};
const db=new PrismaClient({datasourceUrl:url.href});let stage='identity';
const save=()=>writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));
try{
  const [identity]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,current_setting('server_version') AS version`;
  assert.deepEqual({db:identity.db,role:identity.role,superuser:identity.superuser},{db:'p2_clinic_test',role:'p2_clinic',superuser:false});report.postgres=identity.version;
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.equal((await db.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${schema}`).length,0);
  assert.equal((await db.$queryRaw`SELECT 1 FROM pg_roles WHERE rolname IN (${roles.projector},${roles.reader})`).length,0);
  stage='schema';
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);await db.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
  stage='migrations';
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema','services/clinic/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:url.href},stdio:'pipe'});
  const applied=(await db.$queryRawUnsafe(`SELECT migration_name FROM "${schema}"."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)).map(r=>r.migration_name);
  assert.deepEqual(applied,migrations);report.migrations='APPLIED_TO_NEW_TRIAL_SCHEMA_ONLY';report.appliedMigrations=applied.length;
  stage='roles';
  // Cluster roles need the fixture bootstrap superuser; table grants come from the schema owner.
  privilegedSql('p2_clinic_test',`CREATE ROLE "${roles.projector}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; CREATE ROLE "${roles.reader}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT "${roles.projector}","${roles.reader}" TO p2_clinic;`);
  for(const role of Object.values(roles))await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  for(const statement of runtimeGrantStatements('clinic',`"${roles.projector}"`,true,`"${schema}"`))await db.$executeRawUnsafe(statement);
  for(const statement of runtimeGrantStatements('clinic',`"${roles.reader}"`,false,`"${schema}"`))await db.$executeRawUnsafe(statement);
  report.grants='P7_RUNTIME_STATEMENTS_APPLIED_TO_RUN_ROLES';
  await db.$disconnect();stage='tests';save();
  const contextPath=resolve(output,'context.json');writeFileSync(contextPath,JSON.stringify({run,suite,schema,marker,roles,output}),{mode:0o600});
  // Sequential: broker cases build on the state left by the PG cases.
  for(const file of files){stage='tests:'+file;
    execFileSync(process.execPath,['--test','--test-concurrency=1','tools/phase2/cqrs/activity/'+file],{env:{...process.env,ACTIVITY_D2_CONTEXT:contextPath},stdio:'inherit'});}
  report.status='PASS';console.log(JSON.stringify({run,status:'PASS',artifact:output}));
}catch(error){report.status='FAIL';report.failedStage=stage;report.error=error instanceof assert.AssertionError?error.message:error.code??error.name;process.exitCode=1;console.error(JSON.stringify({run,status:report.status,stage,error:report.error}));}
finally{report.finishedAt=new Date().toISOString();await db.$disconnect();save();}
