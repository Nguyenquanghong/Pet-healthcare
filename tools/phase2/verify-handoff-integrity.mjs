// Lightweight archive verification; deliberately does not claim npm ci/runtime
// verification or independent receiver acceptance. No dependency copies.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,verifyBundle,safePath,manifestFile} from './source-provenance.mjs';
const [input,...extra]=process.argv.slice(2),root=resolve('.'),artifacts=resolve('test-results/phase2');
if(!input||extra.length)throw new Error('Usage: node tools/phase2/verify-handoff-integrity.mjs <receipt.json>');
const artifact=path=>{const file=resolve(root,path),rel=relative(artifacts,file);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('SOURCE_ARTIFACT_SCOPE');return file;};
const receiptPath=artifact(input),receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
const archive=artifact(receipt.archive),staging=artifact(receipt.source);
if(sha256(readFileSync(archive))!==receipt.archiveHash)throw new Error('SOURCE_ARCHIVE_HASH');
const staged=verifyBundle(staging,receipt.sourceHash);
if(staged.manifestHash!==receipt.manifestHash)throw new Error('SOURCE_MANIFEST_RECEIPT_MISMATCH');
const files=new Set(staged.files.map(f=>f.path).concat(manifestFile)),directories=new Set();
for(const path of files){const parts=path.split('/');for(let n=1;n<parts.length;n++)directories.add(parts.slice(0,n).join('/'));}
for(const entry of execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split(/\r?\n/)){
  if(entry==='.'||entry==='./')continue;
  const path=entry.replace(/^\.\//,'').replace(/\/$/,'');safePath(path);
  if(!files.has(path)&&!directories.has(path))throw new Error('SOURCE_ARCHIVE_ENTRY');
}
const extracted=resolve(dirname(receiptPath),'integrity-'+randomUUID());mkdirSync(extracted);
execFileSync('tar',['-xzf',archive,'-C',extracted],{stdio:'pipe'});
const manifest=verifyBundle(extracted,receipt.sourceHash);
if(manifest.manifestHash!==receipt.manifestHash)throw new Error('SOURCE_EXTRACTED_MANIFEST_MISMATCH');
const report={status:'passed',kind:'archive-integrity-only',sourceHash:receipt.sourceHash,archiveHash:receipt.archiveHash,manifestHash:receipt.manifestHash,files:manifest.files.length,runtimeExecuted:false,independentReceiver:false,extracted:relative(root,extracted).replaceAll('\\','/')};
writeFileSync(resolve(dirname(receiptPath),'integrity-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
