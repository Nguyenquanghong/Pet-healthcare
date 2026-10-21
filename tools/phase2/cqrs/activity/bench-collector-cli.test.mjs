// collector-cli tests on a fake /proc tree (synthetic; not app measurements).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readLedger,tick,readSamples,monotonicMs} from './bench/collector-cli.mjs';

const root=resolve('test-results/phase2/cqrs/activity/bench-collector-cli-fixture-'+randomUUID());
const proc=root+'/proc',cg=root+'/cgroup',ledger=root+'/ledger.json',out=root+'/samples.jsonl';
test.after(()=>rmSync(root,{recursive:true,force:true}));
function setProc(rows){rmSync(proc,{recursive:true,force:true});
  for(const [pid,ppid,ticks] of rows){mkdirSync(proc+'/'+pid,{recursive:true});writeFileSync(proc+'/'+pid+'/stat',pid+' (node) S '+ppid+' 0 0 0 -1 0 0 0 0 0 '+ticks+' '+ticks+' 0 0 20 0 1 0 0 0 0');}}

test('ledger is re-read each tick; invalid or partial ledger keeps the previous one',()=>{
  mkdirSync(cg,{recursive:true});writeFileSync(cg+'/cpu.stat','usage_usec 1000000\n');setProc([[10,1,5],[20,1,7]]);
  const state={ledger:{}};writeFileSync(ledger,'{"generator":[10]}');
  const a=tick(ledger,out,state,{procRoot:proc,cgroupRoot:cg,clockTicks:100});assert.deepEqual(a.roles,{generator:10});
  writeFileSync(ledger,'{"generator":[10],"api":[20]');const b=tick(ledger,out,state,{procRoot:proc,cgroupRoot:cg,clockTicks:100});
  assert.deepEqual(Object.keys(b.roles),['generator']);
  writeFileSync(ledger,'{"generator":[10],"api":[20]}');const c=tick(ledger,out,state,{procRoot:proc,cgroupRoot:cg,clockTicks:100});
  assert.deepEqual(c.roles,{generator:10,api:14});
  assert.deepEqual(readLedger(root+'/missing.json',{x:[1]}),{x:[1]});assert.deepEqual(readLedger(ledger),{generator:[10],api:[20]});
  writeFileSync(ledger,'{"api":["20"]}');assert.deepEqual(readLedger(ledger,{keep:[1]}),{keep:[1]});
  const rows=readSamples(out);assert.equal(rows.length,3);assert.ok(rows.every((r,i)=>r.at>=0&&typeof r.wallMs==='number'&&(i===0||r.at>=rows[i-1].at)));
});

test('window subcommand prints windowCpu over monotonic ms',()=>{
  const file=root+'/w.jsonl';const at=monotonicMs();
  writeFileSync(file,[{at,clockTicks:100,roles:{api:100},unreadable:[],totalCgroupCpuSeconds:1},{at:at+1000,clockTicks:100,roles:{api:150},unreadable:[],totalCgroupCpuSeconds:2}].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const w=JSON.parse(execFileSync(process.execPath,['tools/phase2/cqrs/activity/bench/collector-cli.mjs','window',file,String(at),String(at+1000),'api'],{encoding:'utf8'}));
  assert.equal(w.complete,true);assert.equal(w.roles.api,0.5);assert.equal(w.applicationCpuSeconds,0.5);assert.equal(w.totalEnvelopeCpuSeconds,1);
});
