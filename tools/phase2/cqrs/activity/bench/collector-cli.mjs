// The tested collector as a separate process for Python-driven studies.
//   run <ledger.json> <samples.jsonl> [intervalMs]   sample until SIGTERM/SIGINT
//   window <samples.jsonl> <startMs> <endMs> <role,...>   print windowCpu JSON
// The ledger file is re-read each tick (a trial writes its roles once the stack is
// ready); an unreadable/partial file keeps the previous ledger. `at` is
// CLOCK_MONOTONIC in ms (process.hrtime), the same clock as Python time.monotonic()
// on Linux, so trial windows need no wall-clock conversion.
import {readFileSync,appendFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {sample,windowCpu} from './collector.mjs';

export const monotonicMs=()=>Number(process.hrtime.bigint()/1000n)/1000;
export function readLedger(file,previous={}){
  try{const value=JSON.parse(readFileSync(file,'utf8'));
    if(value&&typeof value==='object'&&Object.values(value).every(v=>Array.isArray(v)&&v.every(Number.isInteger)))return value;}catch{}
  return previous;
}
export function tick(ledgerFile,outFile,state,options={}){
  state.ledger=readLedger(ledgerFile,state.ledger);
  const s=sample(state.ledger,{...options,at:monotonicMs()});
  appendFileSync(outFile,JSON.stringify({...s,wallMs:Date.now(),ledger:state.ledger})+'\n');return s;
}
export function readSamples(file){return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];}

if(process.argv[1]?.endsWith('collector-cli.mjs')){
  const [command,...args]=process.argv.slice(2);
  if(command==='run'){
    const [ledgerFile,outFile,interval='1000']=args;
    if(!existsSync('/proc/self/stat'))throw new Error('LINUX_PROC_REQUIRED');
    const clockTicks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim()),state={ledger:{}};
    tick(ledgerFile,outFile,state,{clockTicks});
    const timer=setInterval(()=>tick(ledgerFile,outFile,state,{clockTicks}),Number(interval));
    const stop=()=>{clearInterval(timer);tick(ledgerFile,outFile,state,{clockTicks});process.exit(0);};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }else if(command==='window'){
    const [file,start,end,roles]=args;
    process.stdout.write(JSON.stringify(windowCpu(readSamples(file),Number(start),Number(end),roles.split(',')))+'\n');
  }else{process.stderr.write('usage: collector-cli.mjs run <ledger> <out> [ms] | window <samples> <startMs> <endMs> <roles>\n');process.exitCode=2;}
}
