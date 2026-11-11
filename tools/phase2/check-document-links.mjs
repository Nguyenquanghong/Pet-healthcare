// Document links, run from the repository root (`npm run arch:check`, `node tools/phase2/check-document-links.mjs`).
// 1. Every local markdown link ([text](path)) in the documents under phase2-plan, deploy/phase2 and docs must resolve.
// 2. In the documents that describe the system as it is now, every backticked repository file path (`services/clinic/src/relay.ts`, `{a,b}` expanded,
//    an optional `:12` line suffix ignored) must exist. Dated records (evidence, ADRs, study logs) are exempt from that second check: they cite files as they were when written.
// In a git repository "exists" means what a teammate gets from a clone: tracked or untracked-but-not-ignored (`git ls-files -co --exclude-standard`), compared with the case
// git stores. A file that is only on this machine (ignored raw data, a different letter case) fails. Without a .git directory (the detached copy of the handoff
// package) the file system decides, and a reference into a top-level directory the copy does not contain is skipped.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname,join,relative,sep,isAbsolute,posix} from 'node:path';

const root=process.cwd();
const isRepo=existsSync(resolve(root,'.git'));
// A root that is absent (a partial copy, a checkout before the documents were added) is skipped instead of failing the whole run.
const ROOTS=['phase2-plan','deploy/phase2','docs'].filter(dir=>existsSync(resolve(root,dir)));
const HISTORICAL=/^phase2-plan\/(evidence|architecture-work|cqrs|bridge|archive)\//;
// Build output and generated code are documented but never committed. Anchored on purpose: a real source directory must not be swallowed
// (benchmarks/phase2/Results is not exempt: raw data there is git-ignored and must fail, the tracked part passes).
const BUILT=/^backend\/target\/|(^|\/)(node_modules|dist)\/|(^|\/)src\/generated\//;
const PATH_REF=/`((?:backend|frontend|services|packages|tools|deploy|benchmarks|docs|phase2-plan)\/[A-Za-z0-9_.@\-/{},]+\.(?:tsx?|[cm]?js|json|ya?ml|md|sh|py|conf|sql|prisma|css))(?::\d+(?:-\d+)?)?`/g;
const LOCAL_ONLY='not in the repository (git-ignored, or another letter case): only on this clone';

function expand(token){const m=token.match(/^(.*?)\{([^{}]*)\}(.*)$/);return m?[...new Set(m[2].split(',').flatMap(part=>expand(m[1]+part+m[3])))]:[token];}

// The files a clone has, or null outside a repository. A failing git is an error, never an empty answer: an empty set would let every reference through.
function shareable(){
  if(!isRepo)return null;
  const r=spawnSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:1<<28});
  if(r.error||r.status!==0)throw new Error('git ls-files failed: '+(r.error?.message??r.stderr));
  const files=new Set(r.stdout.split('\0').filter(file=>file&&existsSync(resolve(root,file)))),dirs=new Set(['']);// a tracked file deleted from disk is not there
  for(const file of files)for(let dir=posix.dirname(file);dir!=='.'&&!dirs.has(dir);dir=posix.dirname(dir))dirs.add(dir);
  return {files,dirs};
}

function walk(dir){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.name==='node_modules'||entry.name.startsWith('.')?[]:entry.isDirectory()?walk(join(dir,entry.name)):entry.name.endsWith('.md')?[join(dir,entry.name)]:[]);
}

const known=shareable();
const documents=known?[...known.files].filter(file=>file.endsWith('.md')&&ROOTS.some(dir=>file.startsWith(dir+'/'))).sort().map(file=>resolve(root,file)):ROOTS.flatMap(dir=>walk(resolve(root,dir)));

// Why a target is not acceptable, or undefined.
function problem(target){
  const path=relative(root,target).split(sep).join('/');
  if(path.startsWith('..')||isAbsolute(path))return 'outside the repository';
  if(known)return path===''||known.files.has(path)||known.dirs.has(path)?undefined:existsSync(target)?LOCAL_ONLY:'missing';
  if(existsSync(target))return undefined;
  return path.split('/')[0]&&!existsSync(resolve(root,path.split('/')[0]))?undefined:'missing';// a copy without that top-level directory cannot judge the reference
}

const missing=[];
let links=0,codePaths=0;
for(const file of documents){
  const rel=relative(root,file).split(sep).join('/'),text=readFileSync(file,'utf8');
  const report=(link,kind,why)=>missing.push({file:rel,link,kind,why});
  for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
    const link=match[1].trim().replace(/\s+["'].*$/,'').replace(/^<|>$/g,'');if(/^[a-z][a-z0-9+.-]*:|^#/i.test(link))continue;
    let path=link.split('#')[0].split('?')[0];try{path=decodeURIComponent(path);}catch{/* a malformed escape stays as written and is then reported as missing */}
    links++;const why=problem(path.startsWith('/')?resolve(root,path.slice(1)):resolve(dirname(file),path));if(why)report(link,'link',why);
  }
  if(HISTORICAL.test(rel))continue;
  for(const match of text.matchAll(PATH_REF))for(const path of expand(match[1])){
    // The first directory is absent in a partial copy: nothing to judge the path against.
    if(BUILT.test(path)||!existsSync(resolve(root,path.split('/')[0])))continue;
    codePaths++;const why=problem(resolve(root,path));if(why)report(path,'code path',why);
  }
}
if(missing.length){process.stderr.write(JSON.stringify({missing})+'\n');process.exitCode=1;}
else process.stdout.write(JSON.stringify({documents:documents.length,localLinks:links,codePaths,status:'passed'})+'\n');
