import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sha256,verifyBundle,safePath,manifestFile} from './source-provenance.mjs';
import {assertTestProject} from './test-project.mjs';

const [receiptFile,...extra]=process.argv.slice(2),root=resolve('.'),artifactRoot=resolve('test-results/phase2');
if(!receiptFile||extra.length||!process.env.npm_execpath)throw new Error('SOURCE_VERIFY_USAGE_RUN_THROUGH_NPM');
function localArtifact(path){const file=resolve(root,path),rel=relative(artifactRoot,file);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('SOURCE_ARTIFACT_SCOPE');return file;}
const receiptPath=localArtifact(receiptFile),receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
if(receipt.version!==1||!/^[a-f0-9]{64}$/.test(receipt.sourceHash??'')||!/^[a-f0-9]{64}$/.test(receipt.archiveHash??'')||!/^[a-f0-9]{64}$/.test(receipt.manifestHash??''))throw new Error('SOURCE_INVALID_RECEIPT');
const archive=localArtifact(receipt.archive);if(sha256(readFileSync(archive))!==receipt.archiveHash)throw new Error('SOURCE_ARCHIVE_HASH');
const staging=localArtifact(receipt.source),staged=verifyBundle(staging,receipt.sourceHash);if(staged.manifestHash!==receipt.manifestHash)throw new Error('SOURCE_MANIFEST_RECEIPT_MISMATCH');
// Validate every archive pathname against the already verified inventory before
// extracting our hash-pinned archive into a new directory outside the checkout.
const names=new Set(staged.files.map(f=>f.path).concat(manifestFile)),directories=new Set();for(const path of names){const parts=path.split('/');for(let n=1;n<parts.length;n++)directories.add(parts.slice(0,n).join('/'));}
const list=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
for(const name of list){if(name==='./'||name==='.')continue;const path=name.replace(/^\.\//,'').replace(/\/$/,'');safePath(path);if(!names.has(path)&&!directories.has(path))throw new Error('SOURCE_ARCHIVE_ENTRY');}
assertTestProject();
const detached=mkdtempSync(join(tmpdir(),'pet-healthcare-H-'));execFileSync('tar',['-xzf',archive,'-C',detached],{stdio:'pipe'});
const m=verifyBundle(detached,receipt.sourceHash);if(existsSync(resolve(detached,'.git')))throw new Error('SOURCE_GIT_METADATA_IN_BUNDLE');
const id=randomUUID(),reportFile=resolve(dirname(receiptPath),'verification-'+id+'.json'),report={version:1,id,status:'running',sourceHash:m.sourceHash,manifestHash:m.manifestHash,archiveHash:receipt.archiveHash,files:m.files.length,detachedRoot:detached.replaceAll('\\','/'),sameHost:true,independentReceiver:false,gitMetadata:false,commands:[],node:process.version,platform:process.platform};
const save=()=>writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');save();
const env={...process.env,DATABASE_URL:'postgresql://unused:unused@127.0.0.1:55432/unused?schema=runtime',VITE_API_BASE_URL:'/api',P5_E2E_BASELINE:'',PLAYWRIGHT_SKIP_BROWSER_GC:'1'};
// npm ci must install dev tools; Vite build then chooses its production mode.
// NODE_ENV=test/development changes the React bundle and invalidates comparisons.
delete env.NODE_ENV;
function run(args){const command='npm '+args.join(' '),started=Date.now();process.stdout.write(JSON.stringify({handoffCommand:command,sourceHash:m.sourceHash})+'\n');try{execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd:detached,env,stdio:'inherit'});report.commands.push({command,exit:0,durationMs:Date.now()-started});save();}catch(error){report.commands.push({command,exit:error.status??1,durationMs:Date.now()-started});save();throw error;}}
let failure;
try{
  run(['ci']);run(['test']);run(['run','phase2:build']);
  run(['exec','--','playwright','install','chromium']);
  if(process.platform==='win32'){
    const cached=resolve(root,'test-results/phase2/tooling/nginx-1.30.5.zip'),target=resolve(detached,'test-results/phase2/tooling');
    if(existsSync(cached)){if(sha256(readFileSync(cached))!=='e5afe28b6a50bec92c478bfe1a4d3758206b80fb77159277bc5c4e88955c2a35')throw new Error('SOURCE_NGINX_CACHE_HASH');mkdirSync(target,{recursive:true});copyFileSync(cached,resolve(target,'nginx-1.30.5.zip'));}
    run(['run','phase2:prepare:nginx']);
    env.P6_NGINX_BINARY=resolve(detached,'test-results/phase2/tooling/nginx-1.30.5/nginx.exe');
  }
  run(['run','phase2:verify']);run(['run','phase2:test:notification-ui']);
  execFileSync(process.execPath,['tools/phase2/check-document-links.mjs'],{cwd:detached,env,stdio:'inherit'});
  verifyBundle(detached,m.sourceHash);report.sourceUnchangedAfterVerification=true;
  report.status='passed';
}catch(error){failure=error;report.status='failed';report.failureCode=error.code??'HANDOFF_COMMAND_FAILED';}
finally{
  try{execFileSync(process.execPath,['tools/phase2/stop-test.mjs'],{cwd:detached,env,stdio:'inherit'});report.testStackStopped=true;}catch(error){failure??=error;report.status='failed';report.testStackStopped=false;}
  save();
}
process.stdout.write(JSON.stringify({...report,report:relative(root,reportFile).replaceAll('\\','/')})+'\n');if(failure)process.exitCode=1;
