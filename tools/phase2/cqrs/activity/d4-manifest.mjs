// Local D4 provenance only: hashes working-copy source/migrations/builds/harness
// and records the guarded local-trial runs. Writes only the D4 manifest.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const evidence='phase2-plan/cqrs/clinic-activity/evidence',run='test-results/phase2/cqrs/activity/d4-20261021';
const digest=value=>createHash('sha256').update(value).digest('hex');
const entry=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:digest(bytes)};};
const tree=path=>readdirSync(path).flatMap(name=>{const child=path+'/'+name;return statSync(child).isDirectory()?tree(child):[child];});
const hashList=list=>digest(JSON.stringify(list));
const d2Path=evidence+'/d3-development-manifest.json',d2=JSON.parse(readFileSync(d2Path,'utf8'));
const d3={
  added:['tools/phase2/cqrs/activity/reader.test.mjs','tools/phase2/cqrs/activity/reader-http.test.mjs','tools/phase2/cqrs/activity/summary-reader.integration.mjs',
    'tools/phase2/e2e/activity.spec.ts','tools/phase2/cqrs/activity/run-e2e.mjs','tools/phase2/cqrs/activity/d4-manifest.mjs'],
  modified:['services/clinic/src/infrastructure/queries/clinicActivity.ts','services/clinic/src/application/ports/clinicActivityQueries.ts','services/clinic/src/app.ts',
    'services/clinic/src/index.ts','services/clinic/src/activitySummaryEvidence.ts','services/clinic/openapi.json','backend/openapi.json','tools/phase2/e2e-server.mjs',
    'tools/phase2/e2e.config.ts','tools/phase2/ui/activity.spec.ts','tools/phase2/cqrs/activity/run-summary-projector.mjs','tools/phase2/cqrs/activity/evidence.test.mjs','package.json'],
};
const paths=[...new Set([...d2.files.map(f=>f.path).filter(existsSync),...d3.added])].sort();
const files=paths.map(entry),base=new Map(d2.files.map(f=>[f.path,f.sha256]));
const changed=files.filter(f=>base.has(f.path)&&base.get(f.path)!==f.sha256).map(f=>f.path),added=files.filter(f=>!base.has(f.path)).map(f=>f.path);
const missing=d2.files.map(f=>f.path).filter(p=>!existsSync(p));
const migrations=tree('services/clinic/prisma/migrations').sort().map(entry),build=tree('services/clinic/dist').sort().map(entry);
const checksPath=run+'/checks.json',checks=JSON.parse(readFileSync(checksPath,'utf8'));
const manifest={format:'clinic-activity-d4-development-manifest-v1',capturedAtUtc:new Date().toISOString(),
  kind:'LOCAL_SOURCE_BUILD_HARNESS_PLUS_LOCAL_TRIAL_INTEGRATION_NOT_PERFORMANCE',
  branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirtyWorkingTree:true,
  host:{platform:process.platform,arch:process.arch,node:process.version},
  baseline:{manifest:entry(d2Path),sourceTreeSha256:d2.sourceTreeSha256,files:d2.files.length,note:'D3 PASS applies to its recorded source; D4 runs below re-ran D2/D3 suites on this source'},
  hashConvention:'SHA256 of working-copy bytes; sourceTreeSha256 = SHA256 of UTF-8 JSON.stringify(entries sorted by path)',
  d4:d3,sourceTreeSha256:hashList(files),files,changedFromD3:changed,addedFromD3:added,missingFromD3:missing,
  migrations:{sha256:hashList(migrations),files:migrations.length,newInD4:0,applied:'ONLY_RUN_OWNED_TRIAL_SCHEMAS'},
  build:{scope:'services/clinic/dist from npm run activity:build',sha256:hashList(build),files:build.length},
  policy:{acceptance:entry('phase2-plan/cqrs/clinic-activity/acceptance.frozen.json'),fullyFrozen:false,performanceMeasurementsAllowed:false},
  checks:{file:entry(checksPath),...checks},
  integration:checks.integration.map(r=>({...r,report:entry(r.artifact+'/report.json'),cases:existsSync(r.artifact+'/cases.json')?entry(r.artifact+'/cases.json'):null,
    status:JSON.parse(readFileSync(r.artifact+'/report.json','utf8')).status,timings:existsSync(r.artifact+'/cases.json')?JSON.parse(readFileSync(r.artifact+'/cases.json','utf8')).timings??null:null})),
  state:{summaryReader:'IMPLEMENTED; CLINIC_ACTIVITY_MODE source|cached|summary|control (default source); summary/control require CLINIC_ACTIVITY_SUMMARY_EVIDENCE=1',
    activityServing:'default source; summary only in run-owned trial schemas and the isolated D4 E2E schema',listServing:'authoritative',frontendDist:'rebuilt locally by npm run build -w frontend and run-e2e'},
  performanceMeasurements:'NOT_RUN (timings are functional observations on a shared dev host, not benchmark samples)',
};
const path=evidence+'/d4-development-manifest.json',bytes=JSON.stringify(manifest,null,2)+'\n';
assert.ok(!existsSync(path)||JSON.parse(readFileSync(path,'utf8')).format===manifest.format);
writeFileSync(path,bytes);writeFileSync(path.replace('.json','.sha256'),digest(bytes)+'  d4-development-manifest.json\n');
console.log(JSON.stringify({manifest:path,sha256:digest(bytes),sourceTreeSha256:manifest.sourceTreeSha256,files:files.length,changed:changed.length,added:added.length,missing:missing.length}));
