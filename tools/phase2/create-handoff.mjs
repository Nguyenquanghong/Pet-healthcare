import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from './source-provenance.mjs';
import {stageSource} from './stage-source.mjs';

const root=resolve('.'),id=randomUUID(),artifact=resolve('test-results/phase2/handoff-'+id),source=resolve(artifact,'source');
const manifest=stageSource(root,source,id),entries=manifest.files,baseline=manifest.originalLocalBaseline,provenance=manifest.provenance;
const archive=resolve(artifact,'pet-healthcare-phase2-source.tgz');execFileSync('tar',['-czf',archive,'-C',source,'.'],{stdio:'pipe'});
const receipt={version:1,id,sourceHash:manifest.sourceHash,manifestHash:manifest.manifestHash,files:entries.length,bytes:entries.reduce((sum,f)=>sum+f.bytes,0),source:relative(root,source).replaceAll('\\','/'),archive:relative(root,archive).replaceAll('\\','/'),archiveHash:sha256(readFileSync(archive)),originalRequiredFiles:baseline.filter(b=>b.included).map(b=>b.path),originalOmittedFiles:baseline.filter(b=>!b.included).map(b=>b.path),gitHead:provenance.gitHead,dirty:true,validation:'manifest and staged bytes verified; archive extraction/run still required'};
writeFileSync(resolve(artifact,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(receipt)+'\n');
