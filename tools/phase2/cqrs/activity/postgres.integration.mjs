// Functional parity only. Never creates/migrates/seeds/resets a database.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {parseActivityFilter,buildActivityBusiness} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {activitySourceStatement} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';
import {buildActivityFixture} from './fixture.mjs';
process.env.CLINIC_READ_PROJECTION='on';// these suites exercise the maintained projection (default is off)
if(process.argv[2]==='--help'){
  console.log('node tools/phase2/cqrs/activity/postgres.integration.mjs --context <non-secret.json>\nRequires ACTIVITY_TRIAL_DATABASE_URL and an already seeded, UUID-marked, isolated activity schema. Context: run, database, role, schema=activity_<runhex>, marker=clinic-activity:<run>, fixtureRows=10000|100000, seed=20261020, businessDate=2030-10-20. Read-only parity/DATE timezone checks; no startup/migration/seed/reset or performance measurements.');process.exit(0);
}
assert.equal(process.argv[2],'--context');assert.equal(process.argv.length,4);
const c=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));
assert.match(c.run,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hex=c.run.replaceAll('-','');assert.equal(c.schema,'activity_'+hex);assert.equal(c.marker,'clinic-activity:'+c.run);
assert.ok(['p2_clinic_test','p8_clinic','activity_'+hex+'_clinic'].includes(c.database));assert.match(c.role,/^(p2_clinic|p8_clinic|activity_[a-f0-9]{32}_(reader|clinic))$/);
assert.ok([10000,100000].includes(c.fixtureRows));assert.equal(c.seed,20261020);assert.equal(c.businessDate,'2030-10-20');
const target=new URL(process.env.ACTIVITY_TRIAL_DATABASE_URL??'invalid:');assert.equal(target.protocol,'postgresql:');assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
assert.equal(decodeURIComponent(target.pathname.slice(1)),c.database);assert.equal(decodeURIComponent(target.username),c.role);assert.equal(target.searchParams.get('schema'),c.schema);
target.searchParams.set('connection_limit','1');target.searchParams.set('pool_timeout','1');
const db=new PrismaClient({datasourceUrl:target.href}),output=resolve('test-results/phase2/cqrs/activity','pg-'+c.run);
mkdirSync(output,{recursive:true});const report={kind:'D1_FUNCTIONAL_POSTGRES_PARITY_NOT_BENCHMARK',run:c.run,status:'STARTING',cases:[],mutations:false};
try{
  const fixture=buildActivityFixture({rows:c.fixtureRows,seed:c.seed,businessDate:c.businessDate});
  await db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='1500ms'");
    const [id]=await tx.$queryRaw`SELECT current_database() AS db,current_user AS role,current_schema() AS schema`;
    assert.deepEqual(id,{db:c.database,role:c.role,schema:c.schema});
    const [settings]=await tx.$queryRaw`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_setting('server_version') AS serverVersion`;
    assert.equal(settings.isolation,'repeatable read');assert.equal(settings.readonly,'on');report.snapshot=settings;
    const [marker]=await tx.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`;assert.equal(marker?.marker,c.marker);
    const [role]=await tx.$queryRaw`SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false});
    const [table]=await tx.$queryRaw`SELECT n.nspname AS schema,c.relname AS name,has_table_privilege(current_user,c.oid,'SELECT') AS readable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass('appointments')`;
    assert.deepEqual(table,{schema:c.schema,name:'appointments',readable:true});
    const count=await tx.appointment.count();assert.equal(count,c.fixtureRows);
    for(const zone of ['UTC','Asia/Ho_Chi_Minh','Pacific/Honolulu']){
      // Static allowlisted zone names only. DATE parameters must stay DATE in SQL.
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE '"+zone+"'");
      for(const category of ['all','clinic','spa'])for(const groupBy of ['day','month']){
        const filter=parseActivityFilter({from:'2030-09-21',to:c.businessDate,category,groupBy});
        const actual=await tx.$queryRaw(activitySourceStatement(filter)),counts=new Map();
        for(const a of fixture.appointments){
          if(a.appointmentDate<filter.previousFrom||a.appointmentDate>filter.to)continue;
          const spa=a.type.startsWith('spa_');if(category==='spa'&&!spa||category==='clinic'&&spa)continue;
          const key=[a.appointmentDate,a.type,a.status].join('|');counts.set(key,(counts.get(key)??0n)+1n);
        }
        const expected=[...counts].map(([key,n])=>{const [date,type,status]=key.split('|');return {date,type,status,n};});
        assert.deepEqual(buildActivityBusiness(filter,actual),buildActivityBusiness(filter,expected));
        report.cases.push({zone,category,groupBy,status:'PASS'});
      }
    }
  },{isolationLevel:'RepeatableRead',maxWait:50,timeout:30000});
  report.status='PASS_IN_SCOPE';report.fixture=fixture.manifest;
}catch(error){report.status='FAIL';report.errorType=error.name;report.errorCode=error.code??null;process.exitCode=1;}
finally{await db.$disconnect();writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,artifact:output,performance:'NOT_RUN'}));}
