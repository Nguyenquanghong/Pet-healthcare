import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,join} from 'node:path';

export const manifestFile='phase2-handoff-manifest.json';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
export const hashValue=value=>sha256(JSON.stringify(canonical(value)));
const fail=(condition,code)=>{if(!condition)throw new Error('SOURCE_'+code);};
const roots=['backend','frontend','services','packages','tools/phase2','tools/vendor','deploy/phase2','phase2-plan','.github'];
const topFiles=['package.json','package-lock.json','.gitignore','README.md','Dockerfile.frontend'];
export function safePath(path){fail(typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!path.includes(':')&&!path.includes('\0')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'),'INVALID_PATH');return path;}
export function forbidden(path){const parts=path.toLowerCase().split('/'),name=parts.at(-1);return parts.some(p=>['.git','.aws','.codex','.agents','node_modules','dist','generated','test-results','playwright-report','uploads','__pycache__'].includes(p))||name==='.env'||name.startsWith('.env.')&&name!=='.env.example'||/\.(pem|key|p12|pfx|dump|bak|zip|tgz|gz|tsbuildinfo)$/i.test(name)||['vite.config.js','vite.config.d.ts'].includes(name);}
export function inScope(path){return topFiles.includes(path)||roots.some(root=>path.startsWith(root+'/'))||path==='benchmarks/kaggle/fixtureData.mjs'||path==='.env.example';}
function fileBytes(root,path){safePath(path);const file=resolve(root,path),rel=relative(realpathSync(root),realpathSync(file));fail(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink(),'NON_REGULAR_SOURCE_FILE');return readFileSync(file);}
function git(root,args,options={}){return execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe'],...options});}
function assertGitRoot(root){let top;try{top=git(root,['rev-parse','--show-toplevel']).trim();}catch{throw new Error('SOURCE_GIT_ROOT_OR_MANIFEST_REQUIRED');}fail(realpathSync(top).toLowerCase()===realpathSync(root).toLowerCase(),'GIT_ROOT_OR_MANIFEST_REQUIRED');}
export function gitSourceFiles(root=resolve('.')){assertGitRoot(root);return git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(path=>path&&existsSync(resolve(root,path))).sort();}
export function describeFiles(root,paths){return paths.map(path=>{const bytes=fileBytes(root,path);return {path,bytes:bytes.length,sha256:sha256(bytes)};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
export const selectedSourceFiles=root=>gitSourceFiles(root).filter(path=>inScope(path)&&!forbidden(path));
function inspectExtraFiles(root){
  const found=[];
  function walk(directory,prefix=''){for(const item of readdirSync(directory,{withFileTypes:true})){
    const path=prefix+item.name,parts=path.split('/');
    if(item.isSymbolicLink()){if(!['node_modules','dist','generated','.git'].includes(item.name))fail(false,'UNRECORDED_SYMLINK');continue;}
    if(item.isDirectory()){if(!['node_modules','dist','generated','test-results','playwright-report','__pycache__','.git'].includes(item.name))walk(join(directory,item.name),path+'/');continue;}
    if(path===manifestFile||parts.at(-1).endsWith('.tsbuildinfo')||['frontend/vite.config.js','frontend/vite.config.d.ts'].includes(path))continue;
    found.push(path);
  }}walk(root);return found;
}
export function verifyBundle(root=resolve('.'),expectedHash){
  const manifest=JSON.parse(readFileSync(resolve(root,manifestFile),'utf8')),{manifestHash,...body}=manifest;
  fail(body.version===1&&body.kind==='phase2-source-handoff'&&Array.isArray(body.files)&&body.files.length>0,'INVALID_MANIFEST');
  fail(/^[a-f0-9]{64}$/.test(manifestHash??'')&&manifestHash===hashValue(body),'MANIFEST_HASH');
  fail(body.sourceHash===hashValue(body.files)&&(!expectedHash||body.sourceHash===expectedHash),'SOURCE_HASH');
  const names=new Set();for(const entry of body.files){safePath(entry.path);fail(inScope(entry.path)&&!forbidden(entry.path),'FORBIDDEN_SOURCE_FILE');const normalized=entry.path.toLowerCase();fail(!names.has(normalized),'DUPLICATE_PATH');names.add(normalized);fail(Number.isSafeInteger(entry.bytes)&&entry.bytes>=0&&/^[a-f0-9]{64}$/.test(entry.sha256),'INVALID_FILE_DIGEST');fail(existsSync(resolve(root,entry.path)),'MISSING_FILE');const bytes=fileBytes(root,entry.path);fail(bytes.length===entry.bytes&&sha256(bytes)===entry.sha256,'FILE_DRIFT');}
  fail(inspectExtraFiles(root).every(path=>names.has(path.toLowerCase())),'UNRECORDED_FILE');
  fail(/^[a-f0-9]{40,64}$/.test(body.provenance?.gitHead??'')&&/^[a-f0-9]{64}$/.test(body.provenance?.dirtyDiffHash??'')&&/^[a-f0-9]{64}$/.test(body.provenance?.untrackedHash??''),'INVALID_PROVENANCE');
  return manifest;
}
export function readProvenance(root=resolve('.')){
  if(existsSync(resolve(root,manifestFile))){const m=verifyBundle(root);return {...m.provenance,provenanceKind:'verified-handoff-manifest',sourceBundleHash:m.sourceHash,sourceManifestHash:m.manifestHash};}
  assertGitRoot(root);
  const untracked=git(root,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).sort();
  return {gitHead:git(root,['rev-parse','HEAD']).trim(),dirtyDiffHash:hashValue(Buffer.from(git(root,['diff','HEAD','--binary'])).toString('base64')),untrackedHash:hashValue(untracked.map(path=>[path,hashValue(fileBytes(root,path).toString('base64'))])),provenanceKind:'git-worktree'};
}
export function bundleFiles(root=resolve('.')){return existsSync(resolve(root,manifestFile))?verifyBundle(root).files.map(f=>f.path):selectedSourceFiles(root);}
