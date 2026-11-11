// check-document-links.mjs on throwaway trees: links, backticked code paths ({a,b} expanded), dated records exempt, build output exempt, partial copies skipped,
// and, in a git repository, "exists" means what a clone has (an ignored file, a deleted tracked file or another letter case fails).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';

const script=resolve(import.meta.dirname,'check-document-links.mjs');
// The trees are throwaway repositories: nothing of the caller's repository (GIT_DIR, GIT_INDEX_FILE of a hook) may leak into them.
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_')));
const hasGit=spawnSync('git',['--version'],{env}).status===0;
const needsGit={skip:!hasGit&&'git is not installed'};
const LOCAL_ONLY='not in the repository (git-ignored, or another letter case): only on this clone';

function tree(files,{git=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'doclinks-'));
  for(const [path,text] of Object.entries(files)){mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),text);}
  if(git)assert.equal(spawnSync('git',['init','-q'],{cwd:dir,env}).status,0);
  return dir;
}
function run(dir,{keep=false}={}){
  const r=spawnSync(process.execPath,[script],{cwd:dir,env,encoding:'utf8'});
  if(!keep)rmSync(dir,{recursive:true,force:true});
  let missing=[];
  if(r.status===1)try{missing=JSON.parse(r.stderr).missing;}catch{/* an uncaught error is not a report: status 1 with no list */}
  return {status:r.status,out:r.stdout,err:r.stderr,missing};
}
const code={'services/clinic/src/relay.ts':'','services/clinic/src/a.ts':'','services/clinic/src/b.ts':''};

test('links, code paths, {a,b} groups, a :line suffix, a title and a query that exist pass',()=>{
  const r=run(tree({...code,'phase2-plan/README.md':'x','docs/a.md':'[ok](../phase2-plan/README.md) [dir](../services) [t](../phase2-plan/README.md "Title") [q](../phase2-plan/README.md?plain=1#top) [b](<../phase2-plan/README.md> "Title") [web](HTTPS://x.test) [here](#top) `services/clinic/src/relay.ts:12` `services/clinic/src/{a,b}.ts`'}));
  assert.equal(r.status,0);
  assert.deepEqual({links:JSON.parse(r.out).localLinks,codePaths:JSON.parse(r.out).codePaths},{links:5,codePaths:3});
});

test('a link to a file that is not there fails',()=>{
  const r=run(tree({'docs/a.md':'[gone](nope.md)'}));
  assert.equal(r.status,1);
  assert.deepEqual(r.missing.map(m=>[m.file,m.link,m.kind,m.why]),[['docs/a.md','nope.md','link','missing']]);
});

test('a malformed escape in a link is reported, it does not crash the run and the other documents are still checked',()=>{
  const r=run(tree({'docs/a.md':'[bad](100%.md)','docs/b.md':'[gone](nope.md)'}));
  assert.equal(r.status,1);
  assert.deepEqual(r.missing.map(m=>[m.file,m.link]).sort(),[['docs/a.md','100%.md'],['docs/b.md','nope.md']]);
});

test('a backticked path that moved fails, and a {a,b} group names the missing member',()=>{
  const r=run(tree({'services/clinic/src/a.ts':'','docs/a.md':'`services/clinic/src/old.ts` `services/clinic/src/{a,gone}.ts`'}));
  assert.equal(r.status,1);
  assert.deepEqual(r.missing.map(m=>m.link).sort(),['services/clinic/src/gone.ts','services/clinic/src/old.ts']);
});

test('a link or a path outside the repository fails',()=>{
  const r=run(tree({'docs/a.md':'[up](../../elsewhere.md)'}));
  assert.deepEqual(r.missing.map(m=>m.why),['outside the repository']);
});

test('dated records cite files as they were: evidence, ADRs and study logs are exempt from the path check, not from the link check',()=>{
  const stale='`services/clinic/src/old.ts`';
  const r=run(tree({'services/clinic/src/a.ts':'','phase2-plan/evidence/e.md':stale,'phase2-plan/architecture-work/adr.md':stale,'phase2-plan/cqrs/s.md':stale,'phase2-plan/STATUS.md':'ok'}));
  assert.equal(r.status,0);
  assert.equal(run(tree({'phase2-plan/evidence/e.md':'[gone](nope.md)'})).status,1);
});

test('build output and generated code are documented but not committed: judged by the exemption, with the top-level directories present',()=>{
  const files={'backend/x.ts':'','services/clinic/src/a.ts':'','benchmarks/phase2/x.json':'{}'};
  assert.equal(run(tree({...files,'docs/a.md':'`backend/dist/src/workers/billing.js` `services/clinic/src/generated/client/index.js` `backend/target/app.json` `services/clinic/dist/index.js`'})).status,0);
  // What is not exempt: raw data under Results, and a real source directory that only happens to be called like build output elsewhere.
  const r=run(tree({...files,'docs/a.md':'`benchmarks/phase2/Results/x/summary.json` `services/clinic/src/coverage/gone.ts`'}));
  assert.deepEqual(r.missing.map(m=>m.link).sort(),['benchmarks/phase2/Results/x/summary.json','services/clinic/src/coverage/gone.ts']);
});

test('without .git, a partial copy is not failed for a top-level directory it does not have; with .git the same reference fails',needsGit,()=>{
  const files={'docs/a.md':'[out](../kien-truc.md) [d](../elsewhere/x.md) `packages/contracts/src/x.ts`'};
  assert.equal(run(tree(files)).status,0);
  assert.equal(run(tree({'README.txt':'no markdown here'})).status,0);
  assert.equal(JSON.parse(run(tree({'README.txt':'none'})).out).documents,0);
  assert.equal(run(tree({'docs/a.md':'[out](../elsewhere/x.md)'},{git:true})).status,1);
});

test('in a repository an ignored file is refused: another clone does not have it',needsGit,()=>{
  const r=run(tree({'.gitignore':'services/clinic/src/raw/\n','services/clinic/src/a.ts':'','services/clinic/src/raw/data.json':'{}','docs/a.md':'`services/clinic/src/raw/data.json` `services/clinic/src/a.ts`'},{git:true}));
  assert.equal(r.status,1);
  assert.deepEqual(r.missing.map(m=>[m.link,m.why]),[['services/clinic/src/raw/data.json',LOCAL_ONLY]]);
});

test('a link to the repository root in the same run does not switch the ignored-file check off',needsGit,()=>{
  const r=run(tree({'.gitignore':'services/raw/\n','services/raw/d.json':'{}','docs/a.md':'[root](..) `services/raw/d.json`'},{git:true}));
  assert.equal(r.status,1);
  assert.deepEqual(r.missing.map(m=>m.link),['services/raw/d.json']);
});

test('an ignored document is not checked, an untracked one that is not ignored is',needsGit,()=>{
  const r=run(tree({'.gitignore':'docs/raw/\n','docs/raw/note.md':'[gone](nope.md)','docs/keep.md':'[gone](nope2.md)'},{git:true}));
  assert.deepEqual(r.missing.map(m=>[m.file,m.link]),[['docs/keep.md','nope2.md']]);
});

test('a tracked file that was deleted from disk is not there',needsGit,()=>{
  const dir=tree({'services/clinic/src/a.ts':'','docs/a.md':'`services/clinic/src/a.ts`'},{git:true});
  assert.equal(spawnSync('git',['add','-A'],{cwd:dir,env}).status,0);
  unlinkSync(join(dir,'services/clinic/src/a.ts'));
  const r=run(dir);
  assert.deepEqual(r.missing.map(m=>[m.link,m.why]),[['services/clinic/src/a.ts','missing']]);
});

test('another letter case is not the file: a clone on Linux would not find it',needsGit,()=>{
  const r=run(tree({'services/clinic/src/Relay.ts':'','docs/a.md':'`services/clinic/src/relay.ts`'},{git:true}));
  assert.equal(r.status,1);
  assert.equal(r.missing.length,1);
});

test('a git that cannot answer is an error, not an empty answer that lets everything through',needsGit,()=>{
  const dir=tree({'docs/a.md':'ok'});
  writeFileSync(join(dir,'.git'),'not a gitfile');// git answers "invalid gitfile format" (an empty .git directory would make git look in the parent directories instead)
  const r=run(dir);
  assert.notEqual(r.status,0);
  assert.doesNotMatch(r.out,/passed/);
  assert.match(r.err,/git ls-files failed/);
});
