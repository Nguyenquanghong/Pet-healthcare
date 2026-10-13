import {copyFileSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {bundleFiles,describeFiles,readProvenance,hashValue,manifestFile,verifyBundle} from './source-provenance.mjs';
import {baselineRevisions} from './baseline-revisions.mjs';

export function stageSource(root,destination,id){
  if(existsSync(destination))throw new Error('SOURCE_DESTINATION_EXISTS');
  const paths=bundleFiles(root),entries=describeFiles(root,paths),provenance=readProvenance(root);
  const baseline=baselineRevisions(root,[...readFileSync(resolve(root,'phase2-plan/evidence/local-changes.md'),'utf8').matchAll(/- `([^`]+)`: SHA256 `([a-f0-9]+)`/g)].map(m=>({path:m[1],sha256:m[2],included:paths.includes(m[1])})));
  mkdirSync(destination,{recursive:true});for(const path of paths){const target=resolve(destination,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(resolve(root,path),target);}
  const body={version:1,kind:'phase2-source-handoff',id,createdAt:new Date().toISOString(),files:entries,sourceHash:hashValue(entries),provenance,originalLocalBaseline:baseline,scope:'Current authorized dirty source; three services; required original local files included and identified, unrelated benchmarks/old archives omitted. No .git/env/keys/data/generated/build artifacts.'};
  const manifest={...body,manifestHash:hashValue(body)};writeFileSync(resolve(destination,manifestFile),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});verifyBundle(destination,manifest.sourceHash);return manifest;
}
