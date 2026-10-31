// Structure metrics S1-S17 of phase2-plan/PLAN-20261031-diem-kien-truc.md section 2, as JSON on stdout.
// Read-only; `--write-baseline` is the only mode that writes (tools/phase2/arch-baseline.json). No dependencies:
// TypeScript 7 has no createSourceFile, so imports and function bodies are read from a comment/string-blanked copy
// of each file. Line counts are `wc -l` (newline characters). `kind`: measured (read from code), derived (a proxy
// counted from code or rules), manual (cannot be measured by machine; declared value, never compared by the ratchet).
import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,sep,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const defaultRoot=resolve(import.meta.dirname,'../..');
export const BASELINE_PATH='tools/phase2/arch-baseline.json';

// ---- source reading ------------------------------------------------------------------
const SKIP=new Set(['generated','node_modules','dist','coverage']);
export const walk=(dir,exts=['.ts','.tsx'])=>existsSync(dir)?readdirSync(dir,{withFileTypes:true}).flatMap(e=>SKIP.has(e.name)?[]:e.isDirectory()?walk(join(dir,e.name),exts):exts.some(x=>e.name.endsWith(x))&&!e.name.endsWith('.d.ts')?[join(dir,e.name)]:[]):[];
export const wcl=text=>{let n=0;for(let i=text.indexOf('\n');i>=0;i=text.indexOf('\n',i+1))n++;return n;};
const posix=p=>p.split(sep).join('/');
const blank=s=>s.replace(/[^\r\n]/g,' ');
const REGEX_AFTER=new Set(['','(',',','=',':','[','!','&','|','?','{','}',';','+','-','*','%','<','>','~','^']);
const REGEX_KEYWORD=/(?:^|[^\w$])(?:return|typeof|case|void|delete|in|of|yield|await|else|do|throw)$/;
function skipString(s,i){const q=s[i];i++;while(i<s.length){const c=s[i];if(c==='\\'){i+=2;continue;}if(c===q)return i+1;if(c==='\n')return i;i++;}return i;}
function skipBraces(s,i){let depth=0;while(i<s.length){const c=s[i];if(c==="'"||c==='"'){i=skipString(s,i);continue;}if(c==='`'){i=skipTemplate(s,i);continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return i+1;i++;}return i;}
function skipTemplate(s,i){i++;while(i<s.length){const c=s[i];if(c==='\\'){i+=2;continue;}if(c==='`')return i+1;if(c==='$'&&s[i+1]==='{'){i=skipBraces(s,i+1);continue;}i++;}return i;}
// Same-length copy: comments, string and template contents and regex literals become spaces (delimiters and newlines stay).
export function sanitize(src){
  const out=[];let i=0,last='',tail='';
  const emit=(text,significant)=>{out.push(text);if(significant!==undefined){last=significant;tail=(tail+text).slice(-12);}};
  while(i<src.length){
    const c=src[i],next=src[i+1];
    if(c==='/'&&next==='/'){let j=src.indexOf('\n',i);if(j<0)j=src.length;out.push(blank(src.slice(i,j)));i=j;continue;}
    if(c==='/'&&next==='*'){let j=src.indexOf('*/',i+2);j=j<0?src.length:j+2;out.push(blank(src.slice(i,j)));i=j;continue;}
    if(c==="'"||c==='"'){const j=skipString(src,i);emit(c+blank(src.slice(i+1,Math.max(i+1,j-1)))+(src[j-1]===c&&j-1>i?c:''),c);i=j;continue;}
    if(c==='`'){const j=skipTemplate(src,i);emit('`'+blank(src.slice(i+1,Math.max(i+1,j-1)))+'`','`');i=j;continue;}
    if(c==='/'&&(REGEX_AFTER.has(last)||REGEX_KEYWORD.test(tail))){
      let j=i+1,inClass=false,ok=false;
      while(j<src.length){const d=src[j];if(d==='\\'){j+=2;continue;}if(d==='\n')break;if(d==='[')inClass=true;else if(d===']')inClass=false;else if(d==='/'&&!inClass){ok=true;break;}j++;}
      if(ok){let k=j+1;while(/[a-z]/.test(src[k]??''))k++;emit('/'+blank(src.slice(i+1,j))+src.slice(j,k),'/');i=k;continue;}
    }
    emit(c,/\s/.test(c)?undefined:c);i++;
  }
  return out.join('');
}
const matchClose=(code,i,open,close)=>{let depth=0;for(;i<code.length;i++){if(code[i]===open)depth++;else if(code[i]===close&&--depth===0)return i;}return -1;};
const skipWs=(code,i)=>{while(i<code.length&&/\s/.test(code[i]))i++;return i;};
// Index of the `{` that opens a function body, starting right after the parameter list; -1 for an expression body.
function bodyStart(code,i,arrow){
  let j=skipWs(code,i);
  if(code[j]===':'){
    j++;
    for(;j<code.length;j++){
      const c=code[j];
      if(c===';'||c==='=' &&code[j+1]!=='>'||c===')')return -1;
      if(c==='('){j=matchClose(code,j,'(',')');if(j<0)return -1;continue;}
      if(arrow&&c==='='&&code[j+1]==='>')break;
      if(c==='{'){
        let p=j-1;while(p>=0&&/\s/.test(code[p]))p--;
        if(':|&<,(['.includes(code[p])||code[p]==='>'&&code[p-1]==='='){j=matchClose(code,j,'{','}');if(j<0)return -1;continue;}
        return j;
      }
    }
  }
  if(arrow){j=skipWs(code,j);if(code.slice(j,j+2)!=='=>')return -1;j=skipWs(code,j+2);}
  return code[j]==='{'?j:-1;
}
const NOT_METHODS=new Set(['if','for','while','switch','catch','function','return','await','typeof','new','super','void','delete','throw','else','do','import','export','case']);
// Named function bodies (function declarations, `const x = (...) =>`, class and object methods) with their line spans.
export function functions(src){
  const code=sanitize(src),found=new Map(),newlines=[];
  for(let i=code.indexOf('\n');i>=0;i=code.indexOf('\n',i+1))newlines.push(i);
  const lineAt=offset=>{let lo=0,hi=newlines.length;while(lo<hi){const mid=(lo+hi)>>1;if(newlines[mid]<offset)lo=mid+1;else hi=mid;}return lo+1;};
  const add=(name,start,open)=>{
    if(open<0||found.has(open))return;
    const close=matchClose(code,open,'{','}');
    if(close<0)return;
    found.set(open,{name,start,end:close+1,startLine:lineAt(start),endLine:lineAt(close),lines:lineAt(close)-lineAt(start)+1});
  };
  for(const m of code.matchAll(/(?<![\w$.])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^()]*?>)?\s*\(/g)){
    const open=m.index+m[0].length-1,close=matchClose(code,open,'(',')');
    if(close>=0)add(m[1]??'(anonymous)',m.index,bodyStart(code,close+1,false));
  }
  for(const m of code.matchAll(/(?<![\w$.])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=\s*(?:async\s+)?(?=\(|[A-Za-z_$][\w$]*\s*=>|<)/g)){
    let j=m.index+m[0].length;
    if(code[j]==='<'){j=matchClose(code,j,'<','>');if(j<0)continue;j=skipWs(code,j+1);}
    if(code[j]==='('){const close=matchClose(code,j,'(',')');if(close>=0)add(m[1],m.index,bodyStart(code,close+1,true));}
    else{const arrow=code.indexOf('=>',j);if(arrow>=0){const open=skipWs(code,arrow+2);if(code[open]==='{')add(m[1],m.index,open);}}
  }
  for(const m of code.matchAll(/^[ \t]*(?:(?:public|private|protected|static|readonly|override|async|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^()\n]*>)?\s*\(/gm)){
    if(NOT_METHODS.has(m[1]))continue;
    const open=m.index+m[0].length-1,close=matchClose(code,open,'(',')');
    if(close>=0)add(m[1],m.index+m[0].search(/\S/),bodyStart(code,close+1,false));
  }
  return [...found.values()].sort((a,b)=>a.start-b.start);
}
// Relative imports (static, dynamic, re-export) of one file, resolved to files in `known`; package imports are not edges.
export function importEdges(file,src,known){
  const code=sanitize(src),edges=[];
  for(const m of code.matchAll(/\b(?:from|import)\s*\(?\s*(['"])( *)\1/g)){
    const at=m.index+m[0].indexOf(m[1])+1,spec=src.slice(at,at+m[2].length);
    if(!spec.startsWith('.'))continue;
    const base=resolve(dirname(file),spec).replace(/\.js$/,'');
    const target=[base+'.ts',base+'.tsx',join(base,'index.ts'),join(base,'index.tsx')].find(c=>known.has(c));
    if(target)edges.push(target);
  }
  return edges;
}

// A static `from '...'` and a dynamic `import('...')` (permission-matrix.test.mjs uses `await import`) both count.
export const IMPORT_OF=/(?:\bfrom\s*|\bimport\s*\(\s*)/.source;
export const LEGACY_APP=new RegExp(IMPORT_OF+/['"][^'"]*(?:backend\/dist\/src|\.\.\/dist\/src|backend\/src|\.\.\/src)\/app\.(?:js|ts)['"]/.source),PRODUCTION_APP=new RegExp(IMPORT_OF+/['"][^'"]*composition\/core(?:App|Domains)\.(?:js|ts)['"]/.source);

// Names of the jobs in a GitHub workflow file with an uncommented `run:` step that is exactly `command` (no YAML parser:
// jobs are the keys at two-space indent under `jobs:`).
export function ciJobsRunning(workflow,command){
  const jobs=[];let inJobs=false,current;
  for(const line of workflow.split(/\r?\n/)){
    if(/^\S/.test(line)){inJobs=/^jobs:\s*$/.test(line);current=undefined;continue;}
    const key=inJobs&&/^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if(key){current={name:key[1],runs:false};jobs.push(current);continue;}
    if(current&&new RegExp('^\\s*-?\\s*run:\\s*'+command.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*$').test(line))current.runs=true;
  }
  return jobs.filter(j=>j.runs).map(j=>j.name);
}

// ---- layout configuration (a move of files means updating these) ----------------------
// Layer rank: an import from a lower rank to a higher one points against the dependency direction.
const LAYERS={
  core:{dir:'backend/src',rank:{domain:0,lib:0,application:1,infrastructure:2,middleware:2,gateway:3,routes:3,workers:4,composition:4,'app.ts':4,'index.ts':5}},
  clinic:{dir:'services/clinic/src',rank:{domain:0,application:1,infrastructure:2,http:3,'(root)':4}},
};
const CORE_SPLIT_ENTRIES=/^(index\.ts|workers\/(outbox|billing|notification)\.ts)$/;
// Split mode never reaches the monolith: coreApp only calls createApp without the runtime, and the clinical routers that
// coreDomains still mounts are shadowed by the proxy (ADR rule 2.4), so those edges are cut.
const CORE_CLINICAL=/(routes\/(appointments|medicalRecords)|application\/services\/(appointments|medicalRecords)|persistence\/(appointmentRepository|medicalRepository))\.ts$/;
const CORE_CUT=(from,to)=>from==='composition/coreApp.ts'&&to==='app.ts'||from==='composition/coreDomains.ts'&&CORE_CLINICAL.test(to);
const PROOF_CLASSES=/\bclass (ClinicBilling|CoreBilling)\b/;
const SYNC_CALL_RULES=/calls-(confined|declared)/;
const LEGACY_DIR='/legacy/';

// ---- measurement ----------------------------------------------------------------------
export function measure(root=defaultRoot){
  const abs=p=>resolve(root,p),rel=f=>posix(relative(root,f));
  const cache=new Map(),text=f=>cache.get(f)??(cache.set(f,readFileSync(f,'utf8')),cache.get(f));
  const dirs=area=>[...walk(abs(area))];
  const coreFiles=dirs('backend/src'),clinicFiles=dirs('services/clinic/src'),notificationFiles=dirs('services/notification/src');
  const packageFiles=readdirSync(abs('packages'),{withFileTypes:true}).filter(e=>e.isDirectory()).flatMap(e=>dirs('packages/'+e.name+'/src'));
  const backendFiles=[...coreFiles,...clinicFiles,...notificationFiles,...packageFiles];
  const sumLines=files=>files.reduce((a,f)=>a+wcl(text(f)),0);
  const graph=files=>{const known=new Set(files);return new Map(files.map(f=>[f,importEdges(f,text(f),known)]));};
  const metrics={};
  const put=(id,name,kind,better,values,detail,extra={})=>{metrics[id]={id,name,kind,...(better?{better}:{}),...(values?{values}:{}),...extra,...(detail!==undefined?{detail}:{})};};

  // S1: Clinic code in the root of src, outside every layer.
  const clinicRoot=clinicFiles.filter(f=>!relative(abs('services/clinic/src'),f).includes(sep));
  const clinicTotal=sumLines(clinicFiles),clinicRootLines=sumLines(clinicRoot);
  put('S1','Clinic lines in the src root, outside any layer','measured','lower',{lines:clinicRootLines},{files:clinicRoot.length,totalLines:clinicTotal,percent:Math.round(100*clinicRootLines/clinicTotal)});

  // S2: import edges that point against the layer direction.
  const reverse=[];
  for(const [area,{dir,rank}] of Object.entries(LAYERS)){
    const src=abs(dir),g=graph(dirs(dir));
    const layer=f=>{const r=relative(src,f).split(sep);const key=r.length>1?r[0]:area==='core'?r[0]:'(root)';if(!(key in rank))throw new Error(`${area}: no layer rank for '${key}' (${rel(f)}); add it to LAYERS in tools/phase2/arch-metrics.mjs`);return key;};
    for(const [from,tos] of g)for(const to of tos)if(rank[layer(from)]<rank[layer(to)])reverse.push(`${area}: ${layer(from)} -> ${layer(to)}`);
  }
  const reverseCount={};for(const k of reverse)reverseCount[k]=(reverseCount[k]??0)+1;
  put('S2','Import edges against the layer direction','measured','lower',{edges:reverse.length},reverseCount);

  // S3: the time-named directory.
  const phase2Dir=coreFiles.filter(f=>relative(abs('backend/src'),f).split(sep)[0]==='phase2');
  put('S3','Files in the time-named backend/src/phase2','measured','lower',{files:phase2Dir.length,lines:sumLines(phase2Dir)});

  // S4: files that declare Core's routes (call a create*Router factory).
  const routeSites=coreFiles.filter(f=>/\bcreate[A-Z]\w*Router\s*\(/.test(sanitize(text(f)).replace(/\bfunction\s+create[A-Z]\w*Router\s*\(/g,'')));
  put('S4','Places that declare Core routes','measured','lower',{sites:routeSites.length},routeSites.map(rel));

  // S5: test files that run on the monolith's createApp rather than the production composition.
  const testFiles=[...walk(abs('backend/tests'),['.mjs']),...walk(abs('tools/phase2'),['.mjs'])].filter(f=>/\.(test|integration)\.mjs$|p7-legacy-server\.mjs$/.test(f));
  const legacyTests=testFiles.filter(f=>LEGACY_APP.test(text(f))),productionTests=testFiles.filter(f=>PRODUCTION_APP.test(text(f)));
  put('S5','Test files on the monolith createApp, not the production composition','derived','lower',{legacyAppTests:legacyTests.length},{onProductionComposition:productionTests.map(rel),legacyAppTests:legacyTests.map(rel)},{note:'counts files importing backend app.js; the plan asks for a list chosen in K3'});

  // S6: not measurable by machine (declared, never compared).
  put('S6','Routing configurations and variants','manual',null,undefined,'plan section 3 F1: 7 configurations, 4 variants; gateway-routes-single-source (K5) will measure it',{declared:{configurations:7,variants:4}});

  // S7: Clinic routes that escape the scope registry. A route is an element of the registry (http/routes) that mountRoutes mounts behind
  // its PEP: a direct router.get(...) is a route the registry does not know, and an element without `resource` leaves the scope of its URL
  // undecided (assertRoutes refuses it only when the server starts). Same reading as the rule clinic-routes-declare-scope.
  const scopeFiles=[...walk(abs('services/clinic/src/http/routes')),abs('services/clinic/src/http/scope.ts'),abs('services/clinic/src/app.ts')].filter(f=>existsSync(f));
  const routerCalls=[],withoutResource=[],lineOf=(code,index)=>code.slice(0,index).split('\n').length;
  for(const f of scopeFiles){
    const code=sanitize(text(f)),starts=[...code.matchAll(/\{\s*method:\s*(['"`])\s*\1\s*,/g)];
    for(const m of code.matchAll(/\brouter\s*\.\s*(?:get|post|patch|put|delete)\s*\(/g))routerCalls.push(rel(f)+':'+lineOf(code,m.index));
    starts.forEach((m,i)=>{if(!/\bresource\s*:/.test(code.slice(m.index,starts[i+1]?.index??code.length).split(/\bhandler\b/)[0]))withoutResource.push(rel(f)+':'+lineOf(code,m.index));});
  }
  put('S7','Clinic routes declared outside the registry or without a resource','derived','lower',{undeclared:routerCalls.length+withoutResource.length},{routerCalls,withoutResource},{note:'router.get/post/patch/put/delete( calls in http/routes, http/scope.ts and app.ts, plus registry elements with no resource: (rule clinic-routes-declare-scope)'});

  // S8: Prisma calls in Clinic's HTTP layer.
  const httpFiles=[abs('services/clinic/src/app.ts'),...walk(abs('services/clinic/src/http'))].filter(f=>existsSync(f)).map(rel),PRISMA_LINE=/\b(?:db|tx|prisma)\.(?:\$\w+|[a-z]\w*\.[a-z]\w*)\s*\(/;
  const prismaLines=httpFiles.flatMap(f=>sanitize(text(abs(f))).split('\n').flatMap((l,i)=>PRISMA_LINE.test(l)?[f+':'+(i+1)]:[]));
  put('S8','Prisma calls in the Clinic HTTP layer (app.ts and every file in http/)','measured','lower',{lines:prismaLines.length},prismaLines);

  // S9: longest named functions (backend, services and shared packages).
  const fns=backendFiles.flatMap(f=>functions(text(f)).map(fn=>({...fn,file:rel(f)}))).sort((a,b)=>b.lines-a.lines);
  put('S9','Longest function (lines)','measured','lower',{longest:fns[0].lines,over100:fns.filter(f=>f.lines>100).length,over80:fns.filter(f=>f.lines>80).length},fns.slice(0,8).map(f=>`${f.lines} ${f.file}:${f.startLine} ${f.name}`));

  // S10: business routes in the shared packages (a literal path under /api, /auth or /public inside a function).
  const BUSINESS_ROUTE=/(?:\\\/|['"`\/])(?:api|auth|public)(?:\\\/|\/)/,business=new Set();
  for(const f of packageFiles){
    if(rel(f).startsWith('packages/contracts/'))continue;
    const src=text(f),fnsIn=functions(src);
    for(const m of src.matchAll(new RegExp(BUSINESS_ROUTE.source,'g'))){
      const inner=fnsIn.filter(fn=>fn.start<=m.index&&m.index<fn.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
      if(inner)business.add(rel(f)+' '+inner.name);
    }
  }
  put('S10','Functions with business routes in shared packages (excluding contracts)','derived','lower',{functions:business.size},[...business].sort(),{note:'a literal path under /api, /auth or /public inside a function body'});

  // S11: Core code unreachable in split mode.
  const coreGraph=graph(coreFiles),coreRel=f=>posix(relative(abs('backend/src'),f)),byRel=new Map(coreFiles.map(f=>[coreRel(f),f]));
  const entries=coreFiles.filter(f=>CORE_SPLIT_ENTRIES.test(coreRel(f)));
  if(entries.length<4)throw new Error('split-mode entries not found; update CORE_SPLIT_ENTRIES in tools/phase2/arch-metrics.mjs');
  const reached=new Set(),stack=[...entries];
  while(stack.length){const f=stack.pop();if(reached.has(f))continue;reached.add(f);for(const t of coreGraph.get(f))if(!CORE_CUT(coreRel(f),coreRel(t)))stack.push(t);}
  const unreachable=coreFiles.filter(f=>!reached.has(f)&&!coreRel(f).startsWith('legacy/'));
  put('S11','Core code that never runs in split mode, outside legacy/','measured','lower',{files:unreachable.length,lines:sumLines(unreachable)},unreachable.map(f=>wcl(text(f))+' '+coreRel(f)),{note:'plus clinical branches inside 4 shared repositories, not measured'});

  // S12: proof code in src.
  const proofClassFiles=[...coreFiles,...clinicFiles].filter(f=>PROOF_CLASSES.test(text(f))),proofBranches=[...coreFiles,...clinicFiles].filter(f=>!proofClassFiles.includes(f)&&/\bProofAppointment\b/.test(text(f)));
  put('S12','Proof-only code in src (classes used by proof.test.mjs, ProofAppointment branches)','derived','lower',{files:proofClassFiles.length,branches:proofBranches.length},{files:proofClassFiles.map(rel),branches:proofBranches.map(rel)});

  // S13: rules that confine synchronous service calls (a count of rules, not of call directions).
  const rulesSource=text(abs('tools/phase2/check-architecture-rules.mjs')),syncRules=[...rulesSource.matchAll(/^rule\('([^']+)'/gm)].map(m=>m[1]).filter(n=>SYNC_CALL_RULES.test(n));
  put('S13','Rules that check synchronous service-to-service calls','derived','higher',{rules:syncRules.length},syncRules,{note:'plan target is every direction (Core->Clinic, Clinic->Core, Core->Notification, Notification->Core)'});

  // S14: backend files over 400 lines.
  const over400=backendFiles.map(f=>({file:rel(f),lines:wcl(text(f))})).filter(f=>f.lines>400).sort((a,b)=>b.lines-a.lines);
  put('S14','Backend files over 400 lines (services and packages included)','measured','lower',{files:over400.length},over400.map(f=>f.lines+' '+f.file));

  // S15: windows of 6 normalized lines shared by two services; legacy files are left out of the second count.
  const unreachableSet=new Set(unreachable),WINDOW=6;
  const norm=l=>l.replace(/\s+/g,'').replace(/["'`]/g,'').replace(/[,;]$/,''),trivial=l=>!l||/^[{}()[\];,]*$/.test(l)||l.startsWith('//')||l.startsWith('import');
  const windows=(skip)=>{
    const index=new Map();
    for(const [area,files] of [['core',coreFiles],['clinic',clinicFiles],['notification',notificationFiles]])for(const f of files){
      if(skip(f))continue;
      const ls=text(f).split(/\r?\n/).map(norm).filter(l=>!trivial(l));
      for(let i=0;i+WINDOW<=ls.length;i++){const k=ls.slice(i,i+WINDOW).join('\n');(index.get(k)??index.set(k,new Set()).get(k)).add(area);}
    }
    return [...index.values()].filter(a=>a.size>=2).length;
  };
  const all=windows(()=>false),nonLegacy=windows(f=>unreachableSet.has(f)||posix(f).includes(LEGACY_DIR));
  put('S15','Windows of 6 identical lines across services','measured','lower',{windowsOutsideLegacy:nonLegacy,windowsAll:all});

  // S16: frontend files over 500 lines.
  const frontend=walk(abs('frontend/src')).map(f=>({file:rel(f),lines:wcl(text(f))})).filter(f=>f.lines>500).sort((a,b)=>b.lines-a.lines);
  put('S16','Frontend files over 500 lines','measured','lower',{files:frontend.length,largest:frontend[0]?.lines??0},frontend.map(f=>f.lines+' '+f.file));

  // S17: CI jobs that run the ingress test, which drives the compose overlay through the frontend port. A job counts only
  // while package.json still maps the script to a test file that exists and sends its traffic to FRONTEND_PORT.
  const INGRESS_SCRIPT='test:docker:ingress',ingressFile=/^node\s+(\S+\.mjs)$/.exec(JSON.parse(text(abs('package.json'))).scripts?.[INGRESS_SCRIPT]??'')?.[1];
  const ingressWired=Boolean(ingressFile&&existsSync(abs(ingressFile))&&/FRONTEND_PORT/.test(text(abs(ingressFile)))&&/frontendPort/.test(text(abs(ingressFile))));
  const workflowDir=abs('.github/workflows'),ingressJobs=ingressWired&&existsSync(workflowDir)?readdirSync(workflowDir).filter(f=>/\.ya?ml$/.test(f)).flatMap(f=>ciJobsRunning(text(join(workflowDir,f)),'npm run '+INGRESS_SCRIPT).map(job=>f+':'+job)):[];
  put('S17','CI jobs that run the compose nginx ingress test','measured','higher',{runs:ingressJobs.length},ingressJobs.length?ingressJobs:'no CI job runs '+INGRESS_SCRIPT+(ingressWired?'':' (the script or its test file is missing or does not use the frontend port)'));
  return {schema:1,metrics};
}

// ---- baseline ---------------------------------------------------------------------------
export const baselineOf=({metrics})=>({schema:1,metrics:Object.fromEntries(Object.values(metrics).map(m=>[m.id,m.kind==='manual'?{kind:m.kind,declared:m.declared}:{kind:m.kind,better:m.better,values:m.values}]))});
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=measure();
  if(process.argv.includes('--write-baseline'))writeFileSync(resolve(defaultRoot,BASELINE_PATH),JSON.stringify(baselineOf(result),null,2)+'\n');
  else process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
