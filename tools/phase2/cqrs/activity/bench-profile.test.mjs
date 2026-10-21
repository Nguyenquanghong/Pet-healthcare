// Profile digest tests on synthetic trees under a run-owned test-results directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildDigest,normalizeBytes,rootForms,ROOT_TOKEN} from './bench/profile.mjs';

const base=resolve('test-results/phase2/cqrs/activity/bench-profile-fixture-'+randomUUID());
test.after(()=>rmSync(base,{recursive:true,force:true}));
function tree(name,{extra=''}={}){
  const root=base+'/'+name+'/source';mkdirSync(root+'/services/clinic/dist/generated/client',{recursive:true});mkdirSync(root+'/backend/dist',{recursive:true});
  // Prisma-like config: raw posix path, and JSON-escaped Windows-style path.
  writeFileSync(root+'/services/clinic/dist/generated/client/index.js',`const config={"output":{"value":"${root}/services/clinic/src/generated/client"},"sourceFilePath":${JSON.stringify(root.replaceAll('/','\\')+'\\schema.prisma')}};`);
  writeFileSync(root+'/backend/dist/app.js','export const app=1;'+extra);
  writeFileSync(root+'/services/clinic/dist/engine.node',Buffer.from([0,1,2,255,254,...Buffer.from(root),0]));
  return root;
}

test('normalized build digest is independent of the run directory; raw digest is not',()=>{
  const a=tree('run-a'),b=tree('run-b');
  const da=buildDigest(a,['backend/dist','services/clinic/dist']),db=buildDigest(b,['backend/dist','services/clinic/dist']);
  assert.notEqual(da.raw,db.raw);assert.equal(da.normalized,db.normalized);assert.equal(da.files,3);
  assert.deepEqual(da.pathDependentFiles,['services/clinic/dist/engine.node','services/clinic/dist/generated/client/index.js']);
});

test('a real content change still changes the normalized digest; missing dirs are empty',()=>{
  const a=tree('run-c'),b=tree('run-d',{extra:'// changed'});
  assert.notEqual(buildDigest(a,['backend/dist']).normalized,buildDigest(b,['backend/dist']).normalized);
  assert.equal(buildDigest(a,['does/not/exist']).files,0);
});

test('root forms cover raw, slash, JSON-escaped; binary bytes outside the root are preserved',()=>{
  assert.deepEqual(rootForms('C:\\x\\y').sort(),['C:/x/y','C:\\\\x\\\\y','C:\\x\\y','C:\\/x\\/y'].sort());
  assert.deepEqual(rootForms('/tmp/r').sort(),['/tmp/r','\\tmp\\r','\\\\tmp\\\\r','\\/tmp\\/r'].sort());
  const bytes=Buffer.from([0,255,...Buffer.from('/tmp/r/a'),7]);
  assert.deepEqual([...normalizeBytes(bytes,'/tmp/r')],[0,255,...Buffer.from(ROOT_TOKEN+'/a'),7]);
});
