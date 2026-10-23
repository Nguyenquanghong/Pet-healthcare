// `npm run arch:check`: every architecture fitness function in one run, with a
// PASS/FAIL table; exit 1 if any check fails. Read-only (builds contracts only;
// the permission matrix runs the built services, so run phase2:build first).
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../..');
const checks=[
  {name:'inter-service boundaries',protects:'ADR-01, NFR05',command:[process.execPath,'tools/phase2/check-boundaries.mjs']},
  {name:'Core layering',protects:'Phase 1 layering, AQ-13',command:[process.execPath,'backend/scripts/check-architecture.mjs']},
  {name:'architecture rules (layering, events, gateway, grants, permissions)',protects:'ADR-03, NFR04, NFR12, P7 least privilege, AQ-05',command:[process.execPath,'tools/phase2/check-architecture-rules.mjs']},
  {name:'OpenAPI matches routes',protects:'NFR10, NFR12',command:[process.execPath,'backend/scripts/check-openapi.mjs']},
  // One fixed command string (no user input): npm needs a shell on Windows.
  {name:'wire contracts + OpenAPI inventory',protects:'ADR-03/04, NFR10',command:['npm run phase2:test:contracts'],shell:true},
  {name:'notification single writer',protects:'ADR-03, P2',command:[process.execPath,'tools/phase2/check-notification-writers.mjs']},
  {name:'document links',protects:'NFR12 (reproducible handoff)',command:[process.execPath,'tools/phase2/check-document-links.mjs']},
  {name:'permission matrix over HTTP (4 roles x every guard)',protects:'AQ-05, NFR04',command:[process.execPath,'--test','tools/phase2/permission-matrix.test.mjs']},
  {name:'booking lifecycle matrix (every from x to, guards, roles)',protects:'P01, functional correctness',command:[process.execPath,'--test','tools/phase2/lifecycle-matrix.test.mjs']},
  {name:'frontend API types generated from OpenAPI (fresh, aliased)',protects:'AQ-07, NFR10',command:[process.execPath,'--test','tools/phase2/api-types.test.mjs']},
];
const rows=[];
for(const check of checks){
  const started=Date.now(),[cmd,...args]=check.command;
  const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',shell:check.shell??false});
  const tail=((r.stdout||'')+(r.stderr||'')).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]??'';
  rows.push({status:r.status===0?'PASS':'FAIL',check:check.name,protects:check.protects,seconds:((Date.now()-started)/1000).toFixed(1),last:tail.slice(0,140)});
}
for(const r of rows)process.stdout.write(`${r.status}  ${r.check.padEnd(52)} ${r.seconds.padStart(5)}s  [${r.protects}]\n${r.status==='FAIL'?'      '+r.last+'\n':''}`);
const failed=rows.filter(r=>r.status!=='PASS').length;
process.stdout.write(`\n${rows.length-failed}/${rows.length} architecture checks PASS\n`);
process.exitCode=failed?1:0;
