import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sha256} from './source-provenance.mjs';

// A historical baseline must not be rewritten when a later authorized fix changes
// one of its files. Pin BOTH byte hashes and keep the reviewed reason in manifest.
export function baselineRevisions(root,baseline){
  const path=resolve(root,'phase2-plan/evidence/baseline-revisions.json');
  const revisions=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
  if(!Array.isArray(revisions)||new Set(revisions.map(r=>r.path)).size!==revisions.length)throw new Error('SOURCE_INVALID_BASELINE_REVISIONS');
  for(const r of revisions){
    if(!baseline.some(b=>b.path===r.path&&b.sha256===r.originalSha256)||! /^[a-f0-9]{64}$/.test(r.currentSha256??'')||typeof r.reason!=='string'||r.reason.length<20)throw new Error('SOURCE_INVALID_BASELINE_REVISION');
  }
  return baseline.map(b=>{
    if(!existsSync(resolve(root,b.path)))return b;
    const actual=sha256(readFileSync(resolve(root,b.path))),r=revisions.find(r=>r.path===b.path);
    if(actual===b.sha256){if(r)throw new Error('SOURCE_STALE_BASELINE_REVISION');return b;}
    if(!r||actual!==r.currentSha256)throw new Error('SOURCE_ORIGINAL_LOCAL_CHANGED');
    return {...b,currentSha256:actual,authorizedRevision:r};
  });
}
