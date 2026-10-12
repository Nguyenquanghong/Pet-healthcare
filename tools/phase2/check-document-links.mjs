import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';

let files;
try{files=execFileSync('rg',['--files','phase2-plan','deploy/phase2','-g','*.md'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);}
catch(error){if(!['ENOENT','EPERM','EACCES'].includes(error.code))throw error;files=['phase2-plan','deploy/phase2'].flatMap(root=>readdirSync(root,{recursive:true}).filter(path=>path.endsWith('.md')).map(path=>resolve(root,path)));}
let checked=0;const missing=[];
for(const file of files)for(const match of readFileSync(file,'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
  const link=match[1].replace(/^<|>$/g,'');if(/^[a-z]+:|^#/.test(link))continue;
  const path=decodeURIComponent(link.split('#')[0]);checked++;if(!existsSync(resolve(dirname(file),path)))missing.push({file,link});
}
if(missing.length){process.stderr.write(JSON.stringify({missing})+'\n');process.exitCode=1;}
else process.stdout.write(JSON.stringify({documents:files.length,localLinks:checked,status:'passed'})+'\n');
