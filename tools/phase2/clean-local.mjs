import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {stageSource} from './stage-source.mjs';

if(!process.env.npm_execpath)throw new Error('Run through npm run phase2:verify:clean-local');
const root=resolve('.'),id=randomUUID(),destination=resolve('test-results/phase2/clean-'+id),manifest=stageSource(root,destination,id);
const report={kind:'isolated verified source copy on same host',files:manifest.files.length,sourceHash:manifest.sourceHash,destination:destination.replaceAll('\\','/'),commands:[]};
const reportFile=resolve(destination,'test-results/phase2/source-copy-report.json');mkdirSync(resolve(destination,'test-results/phase2'),{recursive:true});writeFileSync(reportFile,JSON.stringify(report,null,2));
const env={...process.env,P6_NGINX_BINARY:process.platform==='win32'?resolve(root,'test-results/phase2/tooling/nginx-1.30.5/nginx.exe'):(process.env.P6_NGINX_BINARY??'nginx'),DATABASE_URL:'postgresql://unused:unused@127.0.0.1:55432/unused?schema=runtime'};
for(const args of [['ci'],['test'],['run','phase2:build'],['run','phase2:test:migration']]){
  const command='npm '+args.join(' ');process.stdout.write(JSON.stringify({cleanCommand:command,sourceHash:report.sourceHash})+'\n');
  execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd:destination,env,stdio:'inherit'});
  report.commands.push({command,exit:0});writeFileSync(reportFile,JSON.stringify(report,null,2));
}
process.stdout.write(JSON.stringify({...report,status:'passed'})+'\n');
