import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,unlinkSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {verifyBundle,readProvenance,manifestFile,hashValue,selectedSourceFiles,inScope,forbidden,sha256} from './source-provenance.mjs';
import {baselineRevisions} from './baseline-revisions.mjs';

const artifacts=resolve('test-results/phase2/source-guards-'+randomUUID());mkdirSync(artifacts,{recursive:true});
const bytes=Buffer.from('{"private":true}\n'),hash=createHash('sha256').update(bytes).digest('hex');
function fixture(name,modify=()=>{}){const root=resolve(artifacts,name);mkdirSync(root);writeFileSync(resolve(root,'package.json'),bytes);const body={version:1,kind:'phase2-source-handoff',files:[{path:'package.json',bytes:bytes.length,sha256:hash}],provenance:{gitHead:'a'.repeat(40),dirtyDiffHash:'b'.repeat(64),untrackedHash:'c'.repeat(64)}};modify(body,root);body.sourceHash=hashValue(body.files);writeFileSync(resolve(root,manifestFile),JSON.stringify({...body,manifestHash:hashValue(body)}));return root;}

test('sealed source works without .git, Prisma clients or built dependencies and refuses a different published hash',()=>{
  const root=fixture('valid'),m=verifyBundle(root);assert.equal(readProvenance(root).provenanceKind,'verified-handoff-manifest');assert.equal(readProvenance(root).sourceBundleHash,m.sourceHash);assert.throws(()=>verifyBundle(root,'0'.repeat(64)),/SOURCE_HASH/);
});

test('Docker and load tools are in handoff scope but private env/data and old Kaggle notebooks remain excluded',()=>{
  for(const path of ['Dockerfile.backend','docker-compose.yml','docker-compose.phase2.yml','.dockerignore','.env.docker.example','tools/docker/prepare-phase2.mjs','benchmarks/phase2/dataset.mjs'])assert.ok(inScope(path)&&!forbidden(path),path);
  for(const path of ['.env.docker','backend/.env.docker.example','benchmarks/phase2/private.key'])assert.ok(forbidden(path),path);
  assert.equal(inScope('benchmarks/kaggle/notebook.ipynb'),false);
});

test('reviewed baseline revisions pin old and new bytes without accepting future drift',()=>{
  const root=resolve(artifacts,'baseline-revisions'),path='README.md',before=sha256('old'),after=sha256('reviewed');
  mkdirSync(resolve(root,'phase2-plan/evidence'),{recursive:true});writeFileSync(resolve(root,path),'reviewed');
  const baseline=[{path,sha256:before,included:true}];
  assert.throws(()=>baselineRevisions(root,baseline),/ORIGINAL_LOCAL_CHANGED/);
  const revisions=resolve(root,'phase2-plan/evidence/baseline-revisions.json');
  writeFileSync(revisions,JSON.stringify([{path,originalSha256:before,currentSha256:after,reason:'Explicitly reviewed later documentation fix.'}]));
  const result=baselineRevisions(root,baseline);assert.equal(result[0].sha256,before);assert.equal(result[0].currentSha256,after);
  writeFileSync(resolve(root,path),'unexpected future edit');assert.throws(()=>baselineRevisions(root,baseline),/ORIGINAL_LOCAL_CHANGED/);
});
test('changed or missing source bytes are rejected before a migration receives provenance',()=>{
  const changed=fixture('changed');writeFileSync(resolve(changed,'package.json'),'{"private":false}\n');assert.throws(()=>readProvenance(changed),/FILE_DRIFT/);
  const absent=fixture('missing',body=>body.files[0].path='backend/not-present.ts');assert.throws(()=>verifyBundle(absent),/MISSING_FILE/);
});
test('traversal, absolute paths, backslash paths and duplicate case-insensitive entries fail closed',()=>{
  for(const [i,path]of ['../outside.txt','C:/outside.txt','/outside.txt','backend\\outside.ts'].entries()){const root=fixture('path-'+i,body=>body.files[0].path=path);assert.throws(()=>verifyBundle(root),/INVALID_PATH/);}
  const duplicate=fixture('duplicate',body=>body.files.push({...body.files[0],path:'PACKAGE.JSON'}));assert.throws(()=>verifyBundle(duplicate),/FORBIDDEN_SOURCE_FILE|DUPLICATE_PATH/);
});
test('credential/data paths and unrecorded source cannot be accepted into a bundle',()=>{
  for(const [i,path]of ['backend/.env','backend/private.key','backend/uploads/image.png','phase2-plan/source.dump','tools/phase2/test-results/snapshot.json'].entries()){const root=fixture('private-'+i,body=>body.files[0].path=path);assert.throws(()=>verifyBundle(root),/FORBIDDEN_SOURCE_FILE/);}
  const extra=fixture('extra');writeFileSync(resolve(extra,'unexpected.js'),'throw new Error();');assert.throws(()=>verifyBundle(extra),/UNRECORDED_FILE/);
  const env=fixture('extra-env');writeFileSync(resolve(env,'.env'),'DATABASE_URL=unreviewed');assert.throws(()=>verifyBundle(env),/UNRECORDED_FILE/);
});
test('build outputs are permitted while source and manifest metadata remain checked',()=>{
  const root=fixture('built');mkdirSync(resolve(root,'frontend/dist'),{recursive:true});writeFileSync(resolve(root,'frontend/dist/index.html'),'generated');verifyBundle(root);
  const m=JSON.parse(readFileSync(resolve(root,manifestFile),'utf8'));m.provenance.gitHead='d'.repeat(40);writeFileSync(resolve(root,manifestFile),JSON.stringify(m));assert.throws(()=>verifyBundle(root),/MANIFEST_HASH/);
});
test('a copy nested below a repository cannot silently use the parent repository as its source',()=>{
  const root=resolve(artifacts,'no-manifest');mkdirSync(root);writeFileSync(resolve(root,'package.json'),bytes);assert.throws(()=>selectedSourceFiles(root),/GIT_ROOT_OR_MANIFEST_REQUIRED/);
});

test('a junction or directory symlink accepts the same Git root and still rejects a nested copy',t=>{
  const root=resolve(artifacts,'git-real-root'),alias=resolve(artifacts,'git-alias');
  mkdirSync(root);writeFileSync(resolve(root,'package.json'),bytes);
  execFileSync('git',['init','--quiet',root],{stdio:'pipe'});
  symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');
  t.after(()=>{assert.equal(resolve(root,'..'),artifacts);assert.equal(resolve(alias,'..'),artifacts);unlinkSync(alias);rmSync(root,{recursive:true,force:true});});
  assert.deepEqual(selectedSourceFiles(alias),['package.json']);
  assert.deepEqual(selectedSourceFiles(alias),selectedSourceFiles(root));
  const nested=resolve(alias,'nested');mkdirSync(nested);writeFileSync(resolve(nested,'package.json'),bytes);
  assert.throws(()=>selectedSourceFiles(nested),/GIT_ROOT_OR_MANIFEST_REQUIRED/);
});
