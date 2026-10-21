// Local D5 provenance only: hashes working-copy source/migrations/builds/harness,
// the readiness notebook artifact and the guarded local-trial runs. Writes only the D5 manifest.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const evidence='phase2-plan/cqrs/clinic-activity/evidence',run='test-results/phase2/cqrs/activity/d5-20261021';
const digest=value=>createHash('sha256').update(value).digest('hex');
const entry=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:digest(bytes)};};
const tree=path=>readdirSync(path).flatMap(name=>{const child=path+'/'+name;return statSync(child).isDirectory()?tree(child):[child];});
const hashList=list=>digest(JSON.stringify(list));
const d4Path=evidence+'/d4-development-manifest.json',d4=JSON.parse(readFileSync(d4Path,'utf8'));
const d5={
  added:['tools/phase2/cqrs/activity/bench/generator.mjs','tools/phase2/cqrs/activity/bench/collector.mjs','tools/phase2/cqrs/activity/bench/evaluator.mjs',
    'tools/phase2/cqrs/activity/bench-generator.test.mjs','tools/phase2/cqrs/activity/bench-collector.test.mjs','tools/phase2/cqrs/activity/bench-evaluator.test.mjs',
    'tools/phase2/cqrs/activity/summary-fault.integration.mjs','tools/phase2/cqrs/activity/summary-smoke.integration.mjs',
    'tools/phase2/cqrs/activity/kaggleD5.mjs','tools/phase2/cqrs/activity/kaggleD5Generator.mjs','tools/phase2/cqrs/activity/d5-manifest.mjs',
    'benchmarks/phase2/kaggle/activity_d5_native.py','benchmarks/phase2/kaggle/make_activity_d5_notebook.py','benchmarks/phase2/kaggle/test_activity_d5.py'],
  modified:['services/clinic/src/readFreshness.ts','services/clinic/src/index.ts','tools/phase2/cqrs/activity/evidence.test.mjs',
    'tools/phase2/cqrs/activity/run-summary-projector.mjs','tools/phase2/cqrs/activity/summary-reader.integration.mjs',
    'tools/phase2/cqrs/activity/summary-rebuild.integration.mjs','package.json'],
};
const paths=[...new Set([...d4.files.map(f=>f.path).filter(existsSync),...d5.added])].sort();
const files=paths.map(entry),base=new Map(d4.files.map(f=>[f.path,f.sha256]));
const changed=files.filter(f=>base.has(f.path)&&base.get(f.path)!==f.sha256).map(f=>f.path),added=files.filter(f=>!base.has(f.path)).map(f=>f.path);
const missing=d4.files.map(f=>f.path).filter(p=>!existsSync(p));
assert.deepEqual([...changed].sort(),[...d5.modified].sort(),'unexpected modified set');
const migrations=tree('services/clinic/prisma/migrations').sort().map(entry),build=tree('services/clinic/dist').sort().map(entry);
const checksPath=run+'/checks.json',checks=JSON.parse(readFileSync(checksPath,'utf8'));
const notebookPath='benchmarks/phase2/clinic-activity-d5-kaggle.ipynb',notebookManifest=notebookPath.replace('.ipynb','.manifest.json');
const notebook=existsSync(notebookPath)?{notebook:entry(notebookPath),manifest:entry(notebookManifest),sha256File:entry(notebookPath.replace('.ipynb','.sha256')),
  sourceArchiveSha256:JSON.parse(readFileSync(notebookManifest,'utf8')).sourceArchiveSha256,execution:'NOT_RUN_ON_KAGGLE'}:null;
const manifest={format:'clinic-activity-d5-development-manifest-v1',capturedAtUtc:new Date().toISOString(),
  kind:'LOCAL_SOURCE_BUILD_HARNESS_PLUS_LOCAL_TRIAL_INTEGRATION_NOT_PERFORMANCE',
  branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirtyWorkingTree:true,
  host:{platform:process.platform,arch:process.arch,node:process.version},
  baseline:{manifest:entry(d4Path),sourceTreeSha256:d4.sourceTreeSha256,files:d4.files.length,note:'D4 PASS applies to its recorded source; D5 runs below re-ran D3/D4 suites on this source'},
  hashConvention:'SHA256 of working-copy bytes; sourceTreeSha256 = SHA256 of UTF-8 JSON.stringify(entries sorted by path)',
  d5,sourceTreeSha256:hashList(files),files,changedFromD4:changed,addedFromD4:added,missingFromD4:missing,
  migrations:{sha256:hashList(migrations),files:migrations.length,newInD5:0,applied:'ONLY_RUN_OWNED_TRIAL_SCHEMAS'},
  build:{scope:'services/clinic/dist from npm run activity:build',sha256:hashList(build),files:build.length},
  policy:{acceptance:entry('phase2-plan/cqrs/clinic-activity/acceptance.frozen.json'),fullyFrozen:false,performanceMeasurementsAllowed:false},
  checks:{file:entry(checksPath),...checks},
  integration:checks.integration.map(r=>{const cases=['cases.json','fault-cases.json','smoke-cases.json'].map(n=>r.artifact+'/'+n).find(existsSync);
    return {...r,report:entry(r.artifact+'/report.json'),cases:cases?entry(cases):null,status:JSON.parse(readFileSync(r.artifact+'/report.json','utf8')).status};}),
  readinessNotebook:notebook,
  state:{freshness:'activity row evidence uses per-aggregate lag (perAggregateLag); list estimator/guard unchanged',
    activityServing:'default source; summary only in run-owned trial schemas',listServing:'authoritative',
    bench:'generator/collector/evaluator implemented and unit-tested; no acceptance sample collected'},
  performanceMeasurements:'NOT_RUN (timings are functional observations on a shared dev host, not benchmark samples)',
};
const path=evidence+'/d5-development-manifest.json',bytes=JSON.stringify(manifest,null,2)+'\n';
assert.ok(!existsSync(path)||JSON.parse(readFileSync(path,'utf8')).format===manifest.format);
writeFileSync(path,bytes);writeFileSync(path.replace('.json','.sha256'),digest(bytes)+'  d5-development-manifest.json\n');
console.log(JSON.stringify({manifest:path,sha256:digest(bytes),sourceTreeSha256:manifest.sourceTreeSha256,files:files.length,changed:changed.length,added:added.length,missing:missing.length}));
