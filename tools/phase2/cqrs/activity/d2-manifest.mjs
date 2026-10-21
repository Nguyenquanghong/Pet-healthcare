// Local D2 provenance only: hashes working-copy source/migrations/builds/harness.
// No service, database, broker, seed or measurement. Writes only the D2 manifest.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const evidence='phase2-plan/cqrs/clinic-activity/evidence',run='test-results/phase2/cqrs/activity/d2-20261021';
const digest=value=>createHash('sha256').update(value).digest('hex');
const entry=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:digest(bytes)};};
const tree=path=>readdirSync(path).flatMap(name=>{const child=path+'/'+name;return statSync(child).isDirectory()?tree(child):[child];});
const hashList=list=>digest(JSON.stringify(list));
const v3Path='benchmarks/phase2/clinic-activity-d1-kaggle-v3.manifest.json',v3=JSON.parse(readFileSync(v3Path,'utf8')).sourceManifest;
assert.equal(v3.files.length,608);
const d2={
  added:['services/clinic/src/projectionVersions.ts','services/clinic/src/clinicActivitySummary.ts',
    'services/clinic/prisma/migrations/20261021000100_appointment_daily_summary_v2/migration.sql',
    'tools/phase2/cqrs/activity/summary.test.mjs','tools/phase2/cqrs/activity/summaryModel.mjs',
    'tools/phase2/cqrs/activity/summary.integration.mjs','tools/phase2/cqrs/activity/summary-broker.integration.mjs','tools/phase2/cqrs/activity/summary-broker-child.mjs',
    'tools/phase2/cqrs/activity/run-summary-projector.mjs','tools/phase2/cqrs/activity/d2-manifest.mjs'],
  modified:['services/clinic/src/appointmentProjector.ts','services/clinic/src/readWorker.ts','services/clinic/src/readFreshness.ts','services/clinic/src/readRebuild.ts',
    'services/clinic/src/infrastructure/queries/servingAppointments.ts','services/clinic/src/infrastructure/queries/shadowAppointments.ts',
    'services/clinic/prisma/schema.prisma','tools/phase2/p7-cutover.mjs','package.json'],
};
const paths=[...new Set([...v3.files.map(f=>f.path).filter(existsSync),...d2.added])].sort();
const files=paths.map(entry),base=new Map(v3.files.map(f=>[f.path,f.sha256]));
const changed=files.filter(f=>base.has(f.path)&&base.get(f.path)!==f.sha256).map(f=>f.path);
const added=files.filter(f=>!base.has(f.path)).map(f=>f.path),missing=v3.files.map(f=>f.path).filter(p=>!existsSync(p));
const migrations=tree('services/clinic/prisma/migrations').sort().map(entry);
const build=tree('services/clinic/dist').sort().map(entry),client=tree('services/clinic/src/generated/client').sort().map(entry);
const blocks=path=>Object.fromEntries([...readFileSync(path,'utf8').replace(/\/\/[^\n]*/g,'').matchAll(/((?:model|enum|generator|datasource)\s+\w+)\s*{([^}]*)}/g)]
  .map(([,name,body])=>[name,body.split('\n').filter(s=>s.trim()).map(s=>s.replace(/\s+/g,'')).sort()]));
assert.deepEqual(blocks('services/clinic/prisma/schema.prisma'),blocks('services/clinic/src/generated/client/schema.prisma'),'Generated Clinic client differs from schema');
const checksPath=run+'/checks.json',checks=JSON.parse(readFileSync(checksPath,'utf8'));
const manifest={format:'clinic-activity-d2-development-manifest-v1',capturedAtUtc:new Date().toISOString(),
  kind:'LOCAL_SOURCE_MIGRATION_BUILD_HARNESS_PLUS_LOCAL_TRIAL_INTEGRATION_NOT_PERFORMANCE',
  branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirtyWorkingTree:true,
  host:{platform:process.platform,arch:process.arch,node:process.version},
  baseline:{manifest:entry(v3Path),sourceTreeSha256:v3.sourceTreeSha256,files:v3.files.length,note:'D1 v3 PASS applies to source608 only; not to this D2 source'},
  hashConvention:'SHA256 of working-copy bytes; sourceTreeSha256 = SHA256 of UTF-8 JSON.stringify(entries sorted by path)',
  d2,sourceTreeSha256:hashList(files),files,changedFromV3:changed,addedFromV3:added,missingFromV3:missing,
  migrations:{sha256:hashList(migrations),files:migrations,d2:'20261021000100_appointment_daily_summary_v2',applied:'NOT_APPLIED_TO_ANY_DATABASE'},
  generatedClient:{prismaGenerate:'RUN_LOCALLY_PRISMA_6.19.3_NO_DB',schemaBlocksMatch:true,sha256:hashList(client),files:client.length},
  build:{scope:'services/clinic/dist from npm run activity:build',sha256:hashList(build),files:build},
  harness:['tools/phase2/cqrs/activity/summary.integration.mjs','tools/phase2/cqrs/activity/summary-broker.integration.mjs','tools/phase2/cqrs/activity/summary-broker-child.mjs','tools/phase2/cqrs/activity/run-summary-projector.mjs','tools/phase2/cqrs/activity/summaryModel.mjs','tools/phase2/cqrs/activity/summary.test.mjs','tools/phase2/test-project.mjs','tools/phase2/p7-environment.mjs'].map(entry),
  fixture:{pg:'synthetic rows created inline by summary(-broker).integration.mjs in each run-owned UUID schema (no seed file, no 10k/100k load)',unit:'in-memory summaryModel.mjs',seededDatabase:'NOT_RUN'},
  policy:{acceptance:entry('phase2-plan/cqrs/clinic-activity/acceptance.frozen.json'),benchmarkPlan:entry(evidence+'/benchmark-plan-20261021.json'),fullyFrozen:false,performanceMeasurementsAllowed:false},
  checks:{file:entry(checksPath),...checks},
  integration:checks.integration.map(r=>({...r,report:entry(r.artifact+'/report.json'),cases:entry(r.artifact+'/cases.json'),brokerCases:existsSync(r.artifact+'/broker-cases.json')?entry(r.artifact+'/broker-cases.json'):null,status:JSON.parse(readFileSync(r.artifact+'/report.json','utf8')).status})),
  state:{pgIntegration:'PASS_ON_LOCAL_PET_PHASE2_P1_TEST',migration:'APPLIED_ONLY_TO_RUN_OWNED_TRIAL_SCHEMAS; not applied to any main/demo DB',worker:'built read worker started only inside broker case on run-scoped queues, stopped',generationV2:'fixture V2 generations only inside run-owned schemas; no rebuild/activate',activityServing:'source (default; no summary reader)',listServing:'authoritative'},
  database:{scope:'dedicated local pet-phase2-p1-test (PostgreSQL 16.15, RabbitMQ 4.1); run-owned schemas/roles/queues retained'},performanceMeasurements:'NOT_RUN',
};
const path=evidence+'/d2-development-manifest.json',bytes=JSON.stringify(manifest,null,2)+'\n';
writeFileSync(path,bytes);writeFileSync(path.replace('.json','.sha256'),digest(bytes)+'  d2-development-manifest.json\n');
console.log(JSON.stringify({manifest:path,sha256:digest(bytes),sourceTreeSha256:manifest.sourceTreeSha256,files:files.length,changed:changed.length,added:added.length,missing:missing.length,migrations:migrations.length,buildFiles:build.length}));
