// Linux resource collector for the Kaggle shared envelope (benchmark-plan
// sessions.accounting): CPU per role from /proc including all descendants
// (PostgreSQL backends, broker/beam children), generator/controller separately,
// root cgroup total separately. Anything unreadable makes coverage incomplete,
// which the evaluator turns into TOTAL_COST_INCONCLUSIVE. Never infers app CPU
// from the shared total.
import {readFileSync,readdirSync,appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export const applicationRoles=['api','worker','relay','postgres','broker','redis','gateway','audit'];
export const separateRoles=['generator','controller'];
// /proc/<pid>/stat: fields after the ")" of comm; ppid=4, utime=14, stime=15,
// cutime=16, cstime=17 (1-based). cutime/cstime = CPU of children already reaped.
export function parseStat(text){
  const close=text.lastIndexOf(')');if(close<0)throw new Error('INVALID_PROC_STAT');
  const rest=text.slice(close+2).trim().split(/\s+/);
  return {ppid:Number(rest[1]),utime:Number(rest[11]),stime:Number(rest[12]),cutime:Number(rest[13]??0),cstime:Number(rest[14]??0),comm:text.slice(text.indexOf('(')+1,close)};
}
export function readTable(procRoot='/proc'){
  const table=new Map();
  for(const name of readdirSync(procRoot)){if(!/^\d+$/.test(name))continue;
    try{table.set(Number(name),parseStat(readFileSync(join(procRoot,name,'stat'),'utf8')));}catch{/* exited between readdir and read */}}
  return table;
}
// Descendants of a role's roots, never crossing into another role's root (e.g.
// the controller spawns the APIs: their subtrees belong to 'api', not 'controller').
const descendants=(table,roots,stop=new Set())=>{const out=new Set(roots.filter(p=>table.has(p)));let grew=true;
  while(grew){grew=false;for(const [pid,s] of table)if(!out.has(pid)&&!stop.has(pid)&&out.has(s.ppid)){out.add(pid);grew=true;}}return out;};
// cgroup v2 cpu.stat usage_usec, else v1 cpuacct.usage (ns). Reported as total only.
export function cgroupCpuSeconds(root='/sys/fs/cgroup'){
  try{const m=/^usage_usec (\d+)$/m.exec(readFileSync(join(root,'cpu.stat'),'utf8'));if(m)return Number(m[1])/1e6;}catch{}
  for(const p of ['cpuacct/cpuacct.usage','cpu,cpuacct/cpuacct.usage'])try{return Number(readFileSync(join(root,p),'utf8'))/1e9;}catch{}
  return null;
}
// ledger: {role:[root pid,...]} recorded when the harness starts each process.
// A role whose roots are all gone is unreadable for that sample (not zero).
// Live descendants' own CPU plus their reaped children's CPU (cutime/cstime): an
// exiting PG backend/beam helper moves into its waiting parent, so the role counter
// stays monotonic. A child re-parented outside the tree still drops out -> reset
// -> incomplete coverage (fail closed, never estimated).
export function sample(ledger,{procRoot='/proc',cgroupRoot='/sys/fs/cgroup',clockTicks=100,at=Date.now()}={}){
  // Integer clock ticks per role; seconds are derived only over a window.
  const table=readTable(procRoot),roles={},unreadable=[],claimed=new Map();
  for(const [role,roots] of Object.entries(ledger)){
    if(!roots.length||!roots.some(p=>table.has(p))){unreadable.push(role);continue;}
    const stop=new Set(Object.entries(ledger).filter(([r])=>r!==role).flatMap(([,p])=>p));
    let ticks=0;for(const pid of descendants(table,roots,stop)){if(claimed.has(pid)&&claimed.get(pid)!==role){unreadable.push(role+':overlap');continue;}claimed.set(pid,role);const s=table.get(pid);ticks+=s.utime+s.stime+s.cutime+s.cstime;}
    roles[role]=ticks;
  }
  return {at,clockTicks,roles,unreadable,totalCgroupCpuSeconds:cgroupCpuSeconds(cgroupRoot)};
}
// Cumulative counters -> CPU seconds per role over intervals fully inside
// [start,end] (policy resourceWindow). Coverage requires every expected role
// readable in every boundary sample and no counter going backwards.
// expected lists the roles that exist as processes in this composition (e.g. the
// summary audit runs inside the Clinic API process, so it is part of 'api').
export function windowCpu(samples,start,end,expected=[...applicationRoles,...separateRoles]){
  const appRoles=expected.filter(r=>!separateRoles.includes(r));
  const inside=samples.filter(s=>s.at>=start&&s.at<=end).sort((a,b)=>a.at-b.at),missing=new Set();
  if(inside.length<2)return {complete:false,reasons:['fewer_than_two_samples'],roles:{},coveredMs:0};
  const first=inside[0],last=inside.at(-1),roles={};
  if(inside.some(s=>s.clockTicks!==first.clockTicks))return {complete:false,reasons:['clock_ticks_changed'],roles:{},coveredMs:0};
  for(const role of expected){
    if(inside.some(s=>s.unreadable.includes(role)||s.unreadable.includes(role+':overlap')||!(role in s.roles))){missing.add(role);continue;}
    let total=0;for(let i=1;i<inside.length;i++){const d=inside[i].roles[role]-inside[i-1].roles[role];if(d<0){missing.add(role+':reset');total=NaN;break;}total+=d;}
    if(Number.isFinite(total))roles[role]=total/first.clockTicks;
  }
  const t0=first.totalCgroupCpuSeconds,t1=last.totalCgroupCpuSeconds;
  const application=appRoles.length&&appRoles.every(r=>r in roles)?appRoles.reduce((a,r)=>a+roles[r],0):null;
  return {complete:missing.size===0,reasons:[...missing].map(r=>'role_unreadable:'+r),roles,applicationCpuSeconds:application,
    separateCpuSeconds:Object.fromEntries(separateRoles.filter(r=>r in roles).map(r=>[r,roles[r]])),
    totalEnvelopeCpuSeconds:t0!=null&&t1!=null?t1-t0:null,coveredMs:last.at-first.at,partialStartMs:first.at-start,partialEndMs:end-last.at};
}
export function startCollector(ledger,file,{intervalMs=1000,...options}={}){
  if(!existsSync('/proc/self/stat'))throw new Error('LINUX_PROC_REQUIRED');
  const write=()=>appendFileSync(file,JSON.stringify(sample(ledger,{...options,at:Date.now()}))+'\n');
  write();const timer=setInterval(write,intervalMs);return {stop(){clearInterval(timer);write();}};
}
