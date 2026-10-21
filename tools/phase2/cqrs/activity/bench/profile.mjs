// Profile helpers shared by Kaggle studies (D5 Kaggle review F1). Prisma clients
// copied into dist embed the absolute generator output/schema path, so a raw build
// digest changes with every private run directory. The profileKey uses a digest
// with the build root replaced by a fixed token (raw, JSON-escaped and slash
// forms); the raw digest is still reported. Nothing else is rewritten.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';

const sha=v=>createHash('sha256').update(v).digest('hex');
export const ROOT_TOKEN='<build-root>';
const files=(root,dir)=>{const base=join(root,dir);if(!existsSync(base))return [];
  const walk=rel=>readdirSync(join(root,rel)).flatMap(name=>{const child=rel+'/'+name;return statSync(join(root,child)).isDirectory()?walk(child):[child];});
  return walk(dir);};
// Longest first so a JSON-escaped form is replaced before its raw prefix could match.
export function rootForms(root){
  const posix=root.replaceAll('\\','/'),windows=posix.replaceAll('/','\\');
  const forms=new Set([root,posix,windows,windows.replaceAll('\\','\\\\'),posix.replaceAll('/','\\/')]);
  return [...forms].filter(f=>f.length>1).sort((a,b)=>b.length-a.length);
}
function replaceAll(buffer,needle,token){
  const parts=[];let from=0,at;
  while((at=buffer.indexOf(needle,from))!==-1){parts.push(buffer.subarray(from,at),token);from=at+needle.length;}
  if(!parts.length)return buffer;parts.push(buffer.subarray(from));return Buffer.concat(parts);
}
export function normalizeBytes(bytes,root){
  let out=bytes;const token=Buffer.from(ROOT_TOKEN);
  for(const form of rootForms(root))out=replaceAll(out,Buffer.from(form),token);
  return out;
}
// Same list convention as the D5 controller: sha256(JSON.stringify([[path,sha],...]))
// with paths relative to the build root, sorted, '/' separated.
export function buildDigest(root,dirs){
  const paths=dirs.flatMap(d=>files(root,d)).sort(),raw=[],normalized=[],pathDependent=[];
  for(const p of paths){const bytes=readFileSync(join(root,p)),norm=normalizeBytes(bytes,root),a=sha(bytes),b=sha(norm);
    raw.push([p,a]);normalized.push([p,b]);if(a!==b)pathDependent.push(p);}
  return {raw:sha(JSON.stringify(raw)),normalized:sha(JSON.stringify(normalized)),files:paths.length,pathDependentFiles:pathDependent,token:ROOT_TOKEN};
}

if(import.meta.url===new URL(process.argv[1],'file://').href||process.argv[1]?.endsWith('profile.mjs')){
  const [command,root,...dirs]=process.argv.slice(2);
  if(command==='build-digest'&&root&&dirs.length){process.stdout.write(JSON.stringify(buildDigest(root,dirs))+'\n');}
  else if(command!==undefined){process.stderr.write('usage: node profile.mjs build-digest <root> <dir>...\n');process.exitCode=2;}
}
