// Service calls (K5, ADR-P15): every synchronous HTTP call between Core, Clinic and Notification is declared in
// deploy/phase2/service-calls.json, and this file reads the code against that declaration. It is shared by the rule
// service-calls-declared (tools/phase2/check-architecture-rules.mjs) and by the metric S13 (tools/phase2/arch-metrics.mjs).
// Read-only, no dependencies beyond the JS reader of gateway-routing.mjs. Every function is pure over an `io` ({read, sources}) and a `today`.
//
// What it checks (a finding starts with the number of the point):
//  (0) the declaration is read and has the shape this file expects; anything else fails, nothing passes silently;
//  (1) every file under the src of the three services (.ts, .mts, .cts; not <src>/generated, not node_modules) that makes an outbound HTTP call
//      (fetch, a reference to the global fetch, an http, https, http2, net or tls module, undici, axios, node-fetch, got; a type-only import is
//      no call) is a call file or an external file of the declaration, and every declared file still makes one; a call file uses fetch only;
//  (2) the literals '/internal...' of a call file are the `match` of the calls declared for it, each declared path starts with its `match`,
//      each `suffix` is a literal of the file, every this.call( of the file (every fetch( when it has none) is one of the declared calls by path,
//      suffixes and method, and each declared call has such a call;
//  (3) no file of the three services other than a declared caller (not a proxy file) or receiver holds a literal '/internal...', also after
//      a host or one or more ${...};
//  (4) a declared path is a route of its receiver file for the declared method and is in packages/contracts/internal/openapi.json; the routes of all
//      receiver files together equal the operations of that spec; the prefixes of a proxy are the gatewayRoutes of its service; a receiver
//      file is read only in the forms app.<method>( and router.<method>( (the router named router, mounted once);
//  (5) every /internal route has a declared call or is in uncalledRoutes with a reason, and an uncalledRoutes entry is not stale;
//  (6) the declared timeout is the literal of the code: AbortSignal.timeout(N), `this.<name>` with a default `<name> = N` of the constructor
//      (and no `new <Class>(` in the caller's src passes that argument), or, for a proxy, `timeoutMs: N` in the serviceProxy({ name: '<x>' ...})
//      object of its config file;
//  (7) a call nested in another has a shorter timeout, or a dated exception with a reason (UTC day, last day counts, at most 60 days ahead;
//      an exception names the two timeouts it was written for, and one that no longer applies or whose timeouts changed fails);
//  (8) a token is in the `scoped` list of backend/src/composition/config.ts, is named in the declared caller and callee wiring files (where each
//      process reads it; a list names every file), belongs to one receiver file only and that file to it; the header (and a bearer or signed
//      actor) is in the call file, and a proxy forwards the declared headers;
//  (9) the receiver file applies its gate: credentialGate (a literal prefix that covers the declared paths, mounted before the routes),
//      acceptsCredential( or acceptsService( on x-service-token.
// What it does not do: it does not run the code (a timeout, token or gate that is changed at run time is not seen); there is no data flow (a token
// swapped between two calls whose names both stay in the wiring file, a gate that is dead code, a header sent from a variable); it follows string
// literals only (a path built from a constant is a finding, a path written without its leading slash or joined from pieces is not seen);
// it checks that a gate is applied in the receiver file, not that it runs for every request; the processes of a caller are declared, not read;
// a call made through a library it does not know is not seen; an alias of fetch through a destructuring of globalThis is not seen; a file that
// only names /internal in a way the point-3 pattern does not match is not seen, and there is no list of files that may name /internal for a good reason.
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {stripJsComments,maskJs,callArguments,fetchUses,daysLeft,isDate,untilFindings} from './gateway-routing.mjs';

export const DECLARATION='deploy/phase2/service-calls.json';
const INTERNAL_SPEC='packages/contracts/internal/openapi.json';
const SCOPED_SOURCE='backend/src/composition/config.ts';
export const SERVICE_SRC={core:'backend/src',clinic:'services/clinic/src',notification:'services/notification/src'};
const SERVICES=Object.keys(SERVICE_SRC);
// The directions the plan names; a direction with no declared call is unchecked.
export const PLAN_DIRECTIONS=['core->clinic','clinic->core','core->notification','notification->core'];
const HTTP_METHODS=['GET','POST','PUT','PATCH','DELETE'];
const SRC_FILE=/^(?:backend\/src|services\/clinic\/src|services\/notification\/src)\/.+\.[cm]?ts$/;
// A source file of a service: a .ts, .mts or .cts under its src; only <src>/generated (the Prisma client) and node_modules are not read.
const inSources=path=>SRC_FILE.test(path)&&!Object.values(SERVICE_SRC).some(dir=>path.startsWith(dir+'/generated/'))&&!path.split('/').includes('node_modules');
const GATES={
  credentialGate:/\.use\s*\([^;]*?\bcredentialGate\s*\(/,
  acceptsCredential:/\bacceptsCredential\s*\(\s*req\.headers\s*\[\s*['"]x-service-token['"]\s*\]/,
  acceptsService:/\.acceptsService\s*\(\s*req\.headers\s*\[\s*['"]x-service-token['"]\s*\]/,
};

// ---- outbound HTTP ------------------------------------------------------------------------
// A call to fetch, any reference to globalThis.fetch, or a static, dynamic or required import of an HTTP/socket client module.
const FETCH_CALL=/(?:^|[^\w$])fetch\s*(?:\?\.\s*)?\(|\bglobalThis\s*(?:\.\s*fetch\b|\[\s*['"]fetch['"])/;
const CLIENT_IMPORT=/\b(?:from|import|require)\s*\(?\s*['"](?:(?:node:)?(?:https?|http2|net|tls)|undici|axios|node-fetch|got)['"]/;
export const HTTP_CALL=new RegExp(FETCH_CALL.source+'|'+CLIENT_IMPORT.source);
// `import type {…} from 'node:http'` is erased by the compiler and loads nothing; every other import of the module still counts.
const withoutTypeImports=code=>code.replace(/\bimport\s+type\s+(?:\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s+from\s*(['"])[^'"\n]*\1\s*;?/g,'');
// The reader is slow on 200 files, and a rule with fixtures reads the same text many times.
const stripped=new Map();
const strip=text=>stripped.get(text)??(stripped.set(text,stripJsComments(text)),stripped.get(text));
// A file makes an outbound call when it calls fetch, refers to the global fetch (an alias, a default value) or imports a client module.
const httpCache=new Map();
export const hasHttpCall=source=>{
  if(!httpCache.has(source)){const code=withoutTypeImports(strip(source));httpCache.set(source,HTTP_CALL.test(code)||fetchUses(code).length>0);}
  return httpCache.get(source);
};
// A call file may use fetch only: any other client module is a second way to make a call that the readers below do not follow.
export const usesClientModule=source=>CLIENT_IMPORT.test(withoutTypeImports(strip(source)));
export function unconfinedHttpCalls(modules,allowed){
  return modules.filter(m=>!allowed.has(m.file)&&hasHttpCall(m.source)).map(m=>m.file);
}

// ---- io -----------------------------------------------------------------------------------
function listSources(root,fs={readdirSync,statSync}){
  const out=[];
  const walk=rel=>{
    for(const e of fs.readdirSync(join(root,rel),{withFileTypes:true})){
      if(e.name==='node_modules'||(e.name==='generated'&&Object.values(SERVICE_SRC).includes(rel)))continue;
      const child=rel+'/'+e.name;
      if(e.isDirectory())walk(child);
      else if(/\.[cm]?ts$/.test(e.name))out.push(child);
    }
  };
  for(const dir of Object.values(SERVICE_SRC))walk(dir);
  return out;
}
export function callsIo(root){
  const cache=new Map();let list;
  return {
    read:path=>cache.get(path)??(cache.set(path,readFileSync(resolve(root,path),'utf8')),cache.get(path)),
    sources:()=>list??(list=listSources(root)),
  };
}
// The same io with some files' text replaced (a fixture); `null` removes a file; a new .ts under a service src joins the sources.
export function fixtureCallsIo(io,files={}){
  return {
    read:path=>{
      if(path in files){if(files[path]===null)throw new Error('ENOENT: '+path);return files[path];}
      return io.read(path);
    },
    sources:()=>[...new Set([...io.sources(),...Object.keys(files).filter(f=>files[f]!==null&&inSources(f))])].filter(f=>files[f]!==null),
  };
}

// ---- dates (UTC, the last day counts, at most 60 days ahead): the functions of gateway-routing.mjs, without a tag -----------
const untilText=(until,today)=>untilFindings('',until,today);

// ---- the declaration -----------------------------------------------------------------------
const isStr=v=>typeof v==='string'&&v.length>0;
const isStrs=v=>Array.isArray(v)&&v.length>0&&v.every(isStr);
const isReason=v=>typeof v==='string'&&v.trim().length>=10;
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const isMs=v=>Number.isInteger(v)&&v>0;
export function declarationErrors(d){
  const e=[];
  if(!isObj(d))return ['the declaration is not a JSON object'];
  if(d.schema!==1)e.push('schema is not 1');
  for(const key of ['calls','external','uncalledRoutes','timeoutExceptions'])if(!Array.isArray(d[key]))e.push(key+' is not an array');
  if(e.length)return e;
  if(!d.calls.length)e.push('calls is empty');
  const ids=new Set();
  d.calls.forEach((c,i)=>{
    const at='calls['+i+']'+(isObj(c)&&isStr(c.id)?' ('+c.id+')':'');
    if(!isObj(c)){e.push(at+' is not an object');return;}
    if(!isStr(c.id))e.push(at+'.id is not a string');
    else if(ids.has(c.id))e.push(at+'.id is listed twice');
    else ids.add(c.id);
    if(!isObj(c.caller)||!SERVICES.includes(c.caller.service)||!isStrs(c.caller.processes))e.push(at+'.caller needs a service of '+SERVICES.join(', ')+' and processes');
    if(!isObj(c.callee)||!SERVICES.includes(c.callee.service))e.push(at+'.callee needs a service of '+SERVICES.join(', '));
    else if(isObj(c.caller)&&c.caller.service===c.callee.service)e.push(at+' calls its own service');
    if(c.kind!=='proxy'&&c.kind!=='http')e.push(at+'.kind is not proxy or http');
    if(!isStrs(c.paths)||!c.paths.every(p=>p.startsWith('/')))e.push(at+'.paths is not a list of paths');
    if(!isStr(c.file))e.push(at+'.file is not a string');
    if(!isMs(c.timeoutMs))e.push(at+'.timeoutMs is not a positive integer');
    if(c.nestedIn!==null&&!isStr(c.nestedIn))e.push(at+'.nestedIn is neither null nor an id');
    if(!isReason(c.reason))e.push(at+'.reason is missing');
    if(c.kind==='proxy'){
      if(c.method!=='*')e.push(at+'.method of a proxy is *');
      if(c.match!==null)e.push(at+'.match of a proxy is null');
      if(!isObj(c.config)||!isStr(c.config.file)||!isStr(c.config.proxy))e.push(at+'.config needs the file and the name of the serviceProxy');
      if(c.credential!==null)e.push(at+'.credential of a proxy is null');
      if(!Array.isArray(c.forwards)||!c.forwards.every(isStr))e.push(at+'.forwards is not a list of headers');
      if(c.receiver!==null)e.push(at+'.receiver of a proxy is null');
    }else if(c.kind==='http'){
      if(!HTTP_METHODS.includes(c.method))e.push(at+'.method is not one of '+HTTP_METHODS.join(', '));
      if(!isStr(c.match))e.push(at+'.match is not a string');
      if(c.suffixes!==undefined&&!(Array.isArray(c.suffixes)&&c.suffixes.every(isStr)))e.push(at+'.suffixes is not a list of strings');
      if(!isObj(c.credential)||!isStr(c.credential.header)||!isStr(c.credential.token)||!['bearer','signed','none'].includes(c.credential.actor)||!isObj(c.credential.wiring)||!isStrs([].concat(c.credential.wiring.caller))||!isStrs([].concat(c.credential.wiring.callee)))e.push(at+'.credential needs header, token, actor (bearer, signed or none) and wiring (the caller files and the callee files that name the token)');
      if(!isObj(c.receiver)||!isStr(c.receiver.file)||!(c.receiver.gate in GATES))e.push(at+'.receiver needs a file and a gate of '+Object.keys(GATES).join(', '));
    }
  });
  d.external.forEach((x,i)=>{
    if(!isObj(x)||!isStr(x.id)||!SERVICES.includes(x.service)||!isStr(x.file)||!isStr(x.system)||!isReason(x.reason))e.push('external['+i+'] needs id, service, file, system and a reason');
  });
  d.uncalledRoutes.forEach((u,i)=>{
    if(!isObj(u)||!SERVICES.includes(u.callee)||!HTTP_METHODS.includes(u.method)||!isStr(u.path)||!u.path.startsWith('/')||!isReason(u.reason))e.push('uncalledRoutes['+i+'] needs callee, method, path and a reason');
  });
  d.timeoutExceptions.forEach((x,i)=>{
    if(!isObj(x)||!isStr(x.outer)||!isStr(x.inner)||!isMs(x.outerMs)||!isMs(x.innerMs))e.push('timeoutExceptions['+i+'] needs outer and inner ids and the timeouts (outerMs, innerMs) they were written for');
  });
  return e;
}

// ---- reading the code ----------------------------------------------------------------------
const norm=path=>path.replace(/:[A-Za-z_]\w*|\{[^}]*\}/g,'{}');
const escapeRe=text=>text.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&');
const literalsOf=(code,start)=>[...code.matchAll(/(['"`])((?:(?!\1)[^\n\\]|\\.)*)\1/g)].map(m=>m[2]).filter(s=>s.startsWith(start));
const hasLiteral=(code,text)=>new RegExp('([\'"`])'+escapeRe(text)+'\\1').test(code);
// fetch( and this.call( calls of a file with their arguments (source text, offsets from the comment-free code).
const spanCache=new Map();
function spansOf(code){
  if(spanCache.has(code))return spanCache.get(code);
  const masked=maskJs(code),out=[];
  for(const [kind,re] of [['fetch',/(?<![\w$.])fetch\s*\(/g],['call',/\bthis\.call\s*\(/g]])
    for(const m of masked.matchAll(re)){
      const open=m.index+m[0].length-1,{args,end}=callArguments(code,open);
      out.push({kind,args,index:open,text:code.slice(open,end<0?code.length:end+1)});
    }
  spanCache.set(code,out);
  return out;
}
// The method of a call, or null when it cannot be read: a string literal as the second argument of this.call(; for fetch(, the `method` key of an
// object literal at its top level (none is GET); a spread, a computed key, a shorthand, a non-literal value or options that are not an object literal give null.
const methodOf=span=>{
  const literal=/^\s*(['"])(\w+)\1\s*$/.exec(span.args[1]??'');
  if(span.kind==='call')return literal?literal[2].toUpperCase():null;
  const options=span.args[1];
  if(options===undefined)return 'GET';
  if(!/^\s*\{/.test(options))return null;
  let method='GET';
  for(const entry of callArguments(options,options.indexOf('{')).args){
    const e=entry.trim();
    if(!e)continue;
    if(e.startsWith('...')||e.startsWith('['))return null;
    const key=/^(['"]?)method\1(?![\w$])\s*([\s\S]*)$/.exec(e);
    if(!key)continue;
    const value=/^:\s*(['"])(\w+)\1$/.exec(key[2].trim());
    if(!value)return null;
    method=value[2].toUpperCase();
  }
  return method;
};
// The routes of a receiver file under /internal: app.<method>('/internal/…'), or router.<method>('/…') behind app.use('/internal', router);
// ${name} of a template is opened only from a `for (const name of ['a','b'])` in the same file.
export function routesIn(code){
  const routes=[],errors=[];
  const loops=new Map([...code.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s*\[([^\]]*)\]/g)].map(m=>[m[1],[...m[2].matchAll(/(['"])([^'"]*)\1/g)].map(x=>x[2])]));
  const mount=/\b\w+\.use\s*\(\s*(['"])(\/[^'"]*)\1\s*,\s*router\s*\)/.exec(code)?.[2]??'';
  // Only forms this reader follows: the router is named router and mounted once, and a route is app.<method>( or router.<method>( with a dot.
  for(const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:express\s*\.\s*)?Router\s*\(/g))if(m[1]!=='router')errors.push('the router is named '+m[1]+', not router');
  const mounts=[...code.matchAll(/\.\s*use\s*\([^()]*\brouter\s*\)/g)].map(m=>m[0]);
  if(mounts.length>1)errors.push(mounts.length+' mounts of router ('+mounts.join(' | ')+'), expected one');
  else if(mounts.length===1&&!/^\.\s*use\s*\(\s*(['"])\/[^'"]*\1\s*,\s*router\s*\)$/.test(mounts[0]))errors.push('the mount of router is not app.use(\'/prefix\', router)');
  for(const m of code.matchAll(/\b([\w$]+)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*(['"`])\/internal/g))if(m[1]!=='app'&&m[1]!=='router')errors.push(m[1]+'.'+m[2]+'(\'/internal…\' is a route on an object this reader does not follow (app or router)');
  for(const m of code.matchAll(/\b([\w$]+)\s*\[\s*(['"])(get|post|put|patch|delete|all|use|route)\2\s*\]\s*\(/g))errors.push(m[1]+'[\''+m[3]+'\']( is a route written in a form this reader does not follow');
  for(const m of code.matchAll(/\b(app|router)\.(get|post|put|patch|delete)\s*\(\s*(['"`])((?:(?!\3)[^\n\\]|\\.)*)\3/g)){
    const base=m[1]==='router'?mount:'';
    let paths=[m[4]];
    for(const name of new Set([...m[4].matchAll(/\$\{\s*(\w+)\s*\}/g)].map(x=>x[1]))){
      if(!loops.has(name)){errors.push('route '+m[2].toUpperCase()+' '+m[4]+': cannot open ${'+name+'} (no for (const '+name+' of [literals]) in the file)');paths=[];break;}
      paths=paths.flatMap(p=>loops.get(name).map(v=>p.replaceAll('${'+name+'}',v)));
    }
    for(const p of paths)if((base+p).startsWith('/internal'))routes.push({method:m[2].toUpperCase(),path:base+p});
  }
  const dynamic=[...code.matchAll(/\b(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*(?![\s'"`])/g)].length;
  if(dynamic)errors.push(dynamic+' route(s) whose path is not a string literal');
  if(/\b(?:app|router)\.(?:all|route)\s*\(/.test(code))errors.push('app.all( or .route( is a form of route this reader does not follow');
  return {routes,errors};
}

const numberOf=text=>Number(text.replaceAll('_',''));

// ---- the analysis --------------------------------------------------------------------------
// `gatewayRoutes` is the list of packages/contracts (prefix, service). Returns the findings with the calls they concern, and the facts the
// metric needs.
export function analyzeCalls(gatewayRoutes,today,io){
  const found=[],add=(point,call,text)=>found.push({point,call:call===null?[]:[].concat(call),text:'('+point+') '+text});
  const result=extra=>({found,calls:[],external:[],uncalled:[],exceptions:[],undeclared:[],httpFiles:[],...extra});
  const sources=io.sources(),texts=new Map(),httpFiles=sources.filter(f=>hasHttpCall(io.read(f)));
  let declaration;
  try{declaration=JSON.parse(io.read(DECLARATION));}
  catch(error){add(0,null,'cannot read '+DECLARATION+': '+error.message);return result({failClosed:true,httpFiles,undeclared:httpFiles});}
  const shape=declarationErrors(declaration);
  const code=path=>{
    if(!texts.has(path)){let text=null;try{text=strip(io.read(path));}catch{/* a missing file is a finding where it is used */}texts.set(path,text);}
    return texts.get(path);
  };
  if(shape.length){
    for(const text of shape)add(0,null,DECLARATION+': '+text);
    return result({failClosed:true,httpFiles,undeclared:httpFiles});
  }
  const {calls,external,uncalledRoutes,timeoutExceptions}=declaration,byId=new Map(calls.map(c=>[c.id,c]));
  const callIdsOfFile=new Map();
  for(const c of calls)callIdsOfFile.set(c.file,[...(callIdsOfFile.get(c.file)??[]),c.id]);

  // (1) every call site is declared, every declared file still makes a call
  const externalIds=new Set(),externalFiles=new Set();
  for(const x of external){
    if(externalIds.has(x.id))add(1,null,'external '+x.id+' is listed twice');
    externalIds.add(x.id);
    if(externalFiles.has(x.file))add(1,null,'external file '+x.file+' is listed twice');
    externalFiles.add(x.file);
    if(callIdsOfFile.has(x.file))add(1,callIdsOfFile.get(x.file),x.file+' is both a call file and external '+x.id);
  }
  const declaredFiles=new Set([...callIdsOfFile.keys(),...externalFiles]);
  const undeclared=httpFiles.filter(f=>!declaredFiles.has(f));
  for(const f of undeclared)add(1,null,f+' makes an outbound HTTP call that '+DECLARATION+' does not declare (add a call or an external entry with a reason)');
  for(const f of declaredFiles){
    const ids=callIdsOfFile.get(f)??[];
    if(!sources.includes(f))add(1,ids,f+' is declared but is not a .ts file under the src of Core, Clinic or Notification');
    else if(!httpFiles.includes(f))add(1,ids,f+' is declared but makes no outbound HTTP call (stale, remove it)');
  }
  for(const c of calls){
    let source='';
    try{source=io.read(c.file);}catch{/* reported above as not a source file */}
    if(usesClientModule(source))add(1,c.id,c.id+': '+c.file+' imports an HTTP client module; a call file may use fetch only (an external file is the place for another client)');
    if(!c.file.startsWith(SERVICE_SRC[c.caller.service]+'/'))add(1,c.id,c.id+': file '+c.file+' is not in the src of its caller '+c.caller.service);
    if(c.receiver&&!c.receiver.file.startsWith(SERVICE_SRC[c.callee.service]+'/'))add(4,c.id,c.id+': receiver file '+c.receiver.file+' is not in the src of its callee '+c.callee.service);
  }

  // (2) paths, suffixes and methods against the caller file
  const httpCalls=calls.filter(c=>c.kind==='http');
  const matchesOfFile=new Map();
  for(const c of httpCalls)matchesOfFile.set(c.file,[...(matchesOfFile.get(c.file)??[]),c]);
  for(const [file,group] of matchesOfFile){
    const text=code(file);
    if(text===null)continue;
    const literals=new Set(literalsOf(text,'/internal')),declared=new Set(group.map(c=>c.match));
    const extra=[...literals].filter(l=>!declared.has(l)),missing=[...declared].filter(m=>!literals.has(m));
    if(extra.length||missing.length)add(2,group.map(c=>c.id),file+': the literals \'/internal…\' of the file differ from the declared match'+(extra.length?'; in the code only: '+extra.join(', '):'')+(missing.length?'; declared only: '+missing.join(', '):''));
    const spans=spansOf(text),fetches=spans.filter(s=>s.kind==='fetch');
    // Every this.call( of the file, or every fetch( when it has no this.call(, is one of the declared calls: it holds the match and the suffixes of
    // one of them and uses its method. The only fetch of a file with no this.call( may build its URL elsewhere.
    const callSpans=spans.filter(s=>s.kind==='call'),sole=!callSpans.length&&fetches.length===1;
    for(const [i,s] of (callSpans.length?callSpans:fetches).entries()){
      const holding=group.filter(c=>sole||(s.text.includes(c.match)&&(c.suffixes??[]).every(x=>s.text.includes(x)))),m=methodOf(s),label=s.kind==='fetch'?'fetch(':'this.call(';
      if(!holding.length)add(2,group.map(c=>c.id),file+': '+label+' number '+(i+1)+' holds none of the declared paths ('+group.map(c=>c.match).join(', ')+'); is it an undeclared call?');
      else if(!holding.some(c=>c.method===m))add(2,holding.map(c=>c.id),file+': '+label+' number '+(i+1)+' uses '+(m??'a method this reader cannot read')+' but the declared calls that hold its path use '+[...new Set(holding.map(c=>c.method))].join(', ')+' (an undeclared call?)');
    }
    for(const c of group){
      for(const p of c.paths)if(!p.startsWith(c.match))add(2,c.id,c.id+': the declared path '+p+' does not start with its match '+c.match);
      for(const s of c.suffixes??[])if(!hasLiteral(text,s))add(2,c.id,c.id+': the suffix \''+s+'\' is not a literal of '+file);
      let mine=spans.filter(s=>s.text.includes(c.match)&&(c.suffixes??[]).every(x=>s.text.includes(x)));
      if(!mine.length&&fetches.length===1&&spans.length===1)mine=fetches;
      if(!mine.length)add(2,c.id,c.id+': no fetch( or this.call( of '+file+' holds \''+c.match+'\'');
      else if(!mine.some(s=>methodOf(s)===c.method))add(2,c.id,c.id+': the code of '+file+' uses '+[...new Set(mine.map(s=>methodOf(s)??'a method it cannot read'))].join(', ')+', the declaration says '+c.method);
    }
  }

  // (3) no other file names /internal
  const allowedInternal=new Set([...httpCalls.map(c=>c.file),...httpCalls.map(c=>c.receiver.file)]);
  for(const f of sources){
    const text=code(f);
    if(text!==null&&!allowedInternal.has(f)&&/(['"`])(?:[a-z][a-z0-9+.-]*:\/\/[^'"`\/]*|(?:\$\{[^}]*\})+)?\/internal(?![\w-])/.test(text))add(3,null,f+' holds a literal \'/internal…\' (alone, after a host or after a ${…}) but is neither a declared caller nor a declared receiver');
  }

  // (4) paths against the routes of the receiver files and the internal OpenAPI file
  const routesOfFile=new Map(),receiverCallee=new Map();
  for(const c of httpCalls){
    if(receiverCallee.has(c.receiver.file)&&receiverCallee.get(c.receiver.file)!==c.callee.service)add(4,c.id,c.id+': receiver file '+c.receiver.file+' is declared for two callees');
    receiverCallee.set(c.receiver.file,c.callee.service);
  }
  for(const file of receiverCallee.keys()){
    const text=code(file);
    if(text===null){add(4,httpCalls.filter(c=>c.receiver.file===file).map(c=>c.id),'receiver file '+file+' cannot be read');routesOfFile.set(file,[]);continue;}
    const {routes,errors}=routesIn(text);
    routesOfFile.set(file,routes.map(r=>r.method+' '+norm(r.path)));
    for(const text of errors)add(4,null,file+': '+text);
  }
  let spec={};
  try{spec=JSON.parse(io.read(INTERNAL_SPEC)).paths??{};}catch(error){add(4,null,'cannot read '+INTERNAL_SPEC+': '+error.message);}
  const specOps=new Set(Object.entries(spec).flatMap(([p,item])=>Object.keys(item).filter(m=>['get','post','put','patch','delete'].includes(m)).map(m=>m.toUpperCase()+' '+norm(p))));
  const allRoutes=new Set([...routesOfFile.values()].flat());
  for(const c of httpCalls)for(const p of c.paths){
    const key=c.method+' '+norm(p);
    if(!(routesOfFile.get(c.receiver.file)??[]).includes(key))add(4,c.id,c.id+': '+c.method+' '+p+' is not a route of '+c.receiver.file+' (it has '+((routesOfFile.get(c.receiver.file)??[]).join(', ')||'none')+')');
    if(!specOps.has(key))add(4,c.id,c.id+': '+c.method+' '+p+' is not an operation of '+INTERNAL_SPEC);
  }
  for(const key of allRoutes)if(!specOps.has(key))add(4,null,'route '+key+' is in a receiver file but not in '+INTERNAL_SPEC);
  for(const key of specOps)if(!allRoutes.has(key))add(4,null,'operation '+key+' of '+INTERNAL_SPEC+' is a route of no declared receiver file');
  for(const c of calls.filter(c=>c.kind==='proxy')){
    const want=gatewayRoutes.filter(r=>r.service===c.callee.service).map(r=>r.prefix).sort(),have=[...c.paths].sort();
    if(JSON.stringify(want)!==JSON.stringify(have))add(4,c.id,c.id+': the declared prefixes ('+have.join(', ')+') are not the gatewayRoutes of '+c.callee.service+' ('+want.join(', ')+')');
  }

  // (5) every route has a caller or a reason
  const covered=new Set(httpCalls.flatMap(c=>c.paths.map(p=>c.method+' '+norm(p))));
  const uncalledSeen=new Set();
  for(const u of uncalledRoutes){
    const key=u.method+' '+norm(u.path),tag='uncalledRoutes '+key+' ('+u.callee+'): ';
    if(uncalledSeen.has(u.callee+' '+key))add(5,null,tag+'listed twice');
    uncalledSeen.add(u.callee+' '+key);
    const files=[...receiverCallee].filter(([,s])=>s===u.callee).map(([f])=>f);
    if(!files.some(f=>(routesOfFile.get(f)??[]).includes(key)))add(5,null,tag+'stale, no receiver file of '+u.callee+' has this route (remove the entry)');
    else if(covered.has(key))add(5,null,tag+'stale, a declared call now reaches it (remove the entry)');
  }
  for(const [file,keys] of routesOfFile)for(const key of keys){
    if(!covered.has(key)&&!uncalledSeen.has(receiverCallee.get(file)+' '+key))add(5,null,'route '+key+' of '+file+' has no declared call and is not in uncalledRoutes');
  }

  // (6) timeouts against the code. A timeout that is the default of a constructor parameter holds only while no caller passes that argument.
  const overrides=(fileText,at,name,c)=>{
    const classes=[...fileText.matchAll(/\bclass\s+(?!(?:implements|extends)\b)([A-Za-z_$][\w$]*)/g)].filter(m=>m.index<at),owner=classes.at(-1);
    const ctor=owner?new RegExp('\\bconstructor\\s*\\(').exec(fileText.slice(owner.index)):null;
    const params=ctor?callArguments(fileText,owner.index+ctor.index+ctor[0].length-1).args:[];
    const position=params.findIndex(a=>new RegExp('\\b'+name+'\\b\\s*(?::\\s*number\\s*)?=\\s*\\d').test(a));
    if(!owner||position<0)return ['the default of '+name+' is not a constructor parameter of the class that makes the call, so its callers cannot be checked'];
    const out=[],make=new RegExp('\\bnew\\s+'+owner[1]+'\\s*(?:<[^>()]*>)?\\s*\\(','g');
    for(const f of sources.filter(f=>f.startsWith(SERVICE_SRC[c.caller.service]+'/'))){
      const text=code(f);
      if(text===null||!text.includes('new '+owner[1]))continue;
      for(const m of maskJs(text).matchAll(make)){
        const args=callArguments(text,m.index+m[0].length-1).args.map(a=>a.trim());
        if(args.at(-1)==='')args.pop();
        if(args.some(a=>a.startsWith('...')))out.push(f+': new '+owner[1]+'( with a spread argument; the default of '+name+' cannot be checked');
        else if(args.length>position)out.push(f+': new '+owner[1]+'( passes '+args.length+' arguments, argument '+(position+1)+' overrides the default of '+name+' (the declared timeout)');
      }
    }
    return out;
  };
  for(const c of calls){
    const fileText=code(c.file);
    if(fileText===null)continue;
    const fetches=spansOf(fileText).filter(s=>s.kind==='fetch');
    let mine=c.kind==='proxy'?fetches:fetches.filter(s=>s.text.includes(c.match));
    if(!mine.length&&fetches.length===1)mine=fetches;
    if(mine.length!==1){add(6,c.id,c.id+': cannot tell which fetch( of '+c.file+' makes the call ('+mine.length+' candidates)');continue;}
    const signal=/AbortSignal\s*\.\s*timeout\s*\(\s*([^()]*?)\s*\)/.exec(mine[0].text);
    if(!signal){add(6,c.id,c.id+': the fetch( of '+c.file+' has no AbortSignal.timeout');continue;}
    const expr=signal[1];
    let ms=null,from=expr;
    if(/^\d[\d_]*$/.test(expr))ms=numberOf(expr);
    else if(/^this\.\w+$/.test(expr)){
      const name=expr.slice(5),m=new RegExp('\\b'+name+'\\s*(?::\\s*number\\s*)?=\\s*(\\d[\\d_]*)').exec(fileText);
      if(m){
        ms=numberOf(m[1]);from='default of '+name;
        for(const text of overrides(fileText,mine[0].index,name,c))add(6,c.id,c.id+': '+text);
      }
    }else if(c.kind==='proxy'&&expr==='target.timeoutMs'){
      const config=code(c.config.file);
      if(config!==null){
        const masked=maskJs(config),objects=[...masked.matchAll(/\bserviceProxy\s*\(/g)].map(m=>callArguments(config,m.index+m[0].length-1).args[0]??'')
          .filter(a=>new RegExp('\\bname\\s*:\\s*([\'"])'+escapeRe(c.config.proxy)+'\\1').test(a));
        if(objects.length!==1)add(6,c.id,c.id+': '+c.config.file+' holds '+objects.length+' serviceProxy({ name: \''+c.config.proxy+'\' …}) calls, expected one');
        else{
          const t=/\btimeoutMs\s*:\s*(\d[\d_]*)/.exec(objects[0]);
          if(t){ms=numberOf(t[1]);from='timeoutMs of serviceProxy '+c.config.proxy;}
          const forwards=/\bforwardRequestHeaders\s*:\s*\[([^\]]*)\]/.exec(objects[0]);
          const list=forwards?[...forwards[1].matchAll(/(['"])([^'"]*)\1/g)].map(m=>m[2]):null;
          if(!list||JSON.stringify([...list].sort())!==JSON.stringify([...c.forwards].sort()))add(8,c.id,c.id+': the proxy forwards ['+(list??['unreadable']).join(', ')+'], the declaration says ['+c.forwards.join(', ')+']');
        }
      }
    }
    if(ms===null)add(6,c.id,c.id+': cannot read the timeout from AbortSignal.timeout('+expr+') in '+c.file);
    else if(ms!==c.timeoutMs)add(6,c.id,c.id+': declared timeout '+c.timeoutMs+' ms, the code says '+ms+' ms ('+from+')');
  }

  // (7) a nested call is shorter than the call around it, or has a dated exception
  const exceptionSeen=new Set(),excepted=new Set();
  for(const x of timeoutExceptions){
    const tag='exception '+x.outer+' > '+x.inner+': ',pair=x.outer+' > '+x.inner;
    if(!isReason(x.reason))add(7,null,tag+'no reason');
    if(!byId.has(x.outer)||!byId.has(x.inner)){add(7,null,tag+'a call id is not declared');continue;}
    if(exceptionSeen.has(pair)){add(7,null,tag+'duplicate exception');continue;}
    exceptionSeen.add(pair);
    for(const text of untilText(x.until,today))add(7,null,tag+text);
    const inner=byId.get(x.inner),outer=byId.get(x.outer);
    if(inner.nestedIn!==x.outer)add(7,x.inner,tag+x.inner+' is not nested in '+x.outer);
    else if(inner.timeoutMs<outer.timeoutMs)add(7,x.inner,tag+'stale, the inner timeout ('+inner.timeoutMs+' ms) is now shorter than the outer ('+outer.timeoutMs+' ms) (remove the exception)');
    else if(inner.timeoutMs!==x.innerMs||outer.timeoutMs!==x.outerMs)add(7,x.inner,tag+'written for '+x.innerMs+' ms inside '+x.outerMs+' ms, the timeouts are now '+inner.timeoutMs+' ms inside '+outer.timeoutMs+' ms: review the exception');
    else excepted.add(pair);
  }
  for(const c of calls){
    if(c.nestedIn===null)continue;
    const outer=byId.get(c.nestedIn);
    if(!outer){add(7,c.id,c.id+': nestedIn '+c.nestedIn+' is not a declared call');continue;}
    if(outer.callee.service!==c.caller.service)add(7,c.id,c.id+': nested in '+outer.id+', which calls '+outer.callee.service+', but the caller of '+c.id+' is '+c.caller.service);
    if(c.timeoutMs>=outer.timeoutMs&&!excepted.has(outer.id+' > '+c.id))add(7,c.id,c.id+': timeout '+c.timeoutMs+' ms is not shorter than '+outer.id+' ('+outer.timeoutMs+' ms) that it runs inside, and no exception covers it');
  }

  // (8) credentials
  let scoped=[];
  try{
    const m=/\bconst\s+scoped\s*=\s*\[([^\]]*)\]/.exec(code(SCOPED_SOURCE)??'');
    scoped=m?[...m[1].matchAll(/(['"])([^'"]*)\1/g)].map(x=>x[2]):[];
  }catch{/* reported below */}
  if(!scoped.length)add(8,null,'cannot read the scoped credentials list of '+SCOPED_SOURCE);
  const tokenFiles=new Map(),fileTokens=new Map();
  for(const c of httpCalls){
    const {header,token,actor}=c.credential;
    if(!scoped.includes(token))add(8,c.id,c.id+': token '+token+' is not in the scoped list of '+SCOPED_SOURCE+' ('+(scoped.join(', ')||'none')+')');
    const named=new RegExp('(?:[\'"`]|process\\.env\\.)'+escapeRe(token)+'(?![\\w])');
    for(const [side,service] of [['caller',c.caller.service],['callee',c.callee.service]]){
      // each process of the side reads the token in its own file, so each file of the list names it
      for(const file of [].concat(c.credential.wiring[side])){
        if(!file.startsWith(SERVICE_SRC[service]+'/'))add(8,c.id,c.id+': the '+side+' wiring file '+file+' is not in the src of '+service);
        else if(!named.test(code(file)??''))add(8,c.id,c.id+': token '+token+' is not named in '+file+', where the '+side+' '+service+' reads it');
      }
    }
    const headerRe=new RegExp('([\'"`])'+escapeRe(header)+'\\1','i'),callerText=code(c.file)??'',receiverText=code(c.receiver.file)??'';
    if(!headerRe.test(callerText))add(8,c.id,c.id+': the header '+header+' is not named in '+c.file);
    if(!headerRe.test(receiverText))add(8,c.id,c.id+': the header '+header+' is not named in '+c.receiver.file);
    if(actor==='bearer'&&!/\bAuthorization\b/.test(callerText))add(8,c.id,c.id+': declared with a bearer actor but '+c.file+' sets no Authorization header');
    if(actor==='signed'&&!(/\bsignToken\s*\(/.test(callerText)&&/\bAuthorization\b/.test(callerText)))add(8,c.id,c.id+': declared with a signed actor but '+c.file+' does not both call signToken( and set an Authorization header');
    tokenFiles.set(token,new Set([...(tokenFiles.get(token)??[]),c.receiver.file]));
    fileTokens.set(c.receiver.file,new Set([...(fileTokens.get(c.receiver.file)??[]),token]));
  }
  for(const [token,files] of tokenFiles)if(files.size>1)add(8,httpCalls.filter(c=>c.credential.token===token).map(c=>c.id),'token '+token+' opens more than one receiver ('+[...files].join(', ')+'): one credential per endpoint group');
  for(const [file,tokens] of fileTokens)if(tokens.size>1)add(8,httpCalls.filter(c=>c.receiver.file===file).map(c=>c.id),'receiver '+file+' is called with more than one token ('+[...tokens].join(', ')+')');

  // (9) the receiver applies its gate
  for(const file of receiverCallee.keys()){
    const text=code(file)??'',gates=new Set(httpCalls.filter(c=>c.receiver.file===file).map(c=>c.receiver.gate)),ids=httpCalls.filter(c=>c.receiver.file===file).map(c=>c.id);
    for(const gate of gates){
      if(!GATES[gate].test(text)){add(9,ids,'receiver '+file+' does not apply its gate '+gate+' (a credential check on x-service-token)');continue;}
      if(gate!=='credentialGate')continue;
      // credentialGate guards what is mounted under its prefix, after it: the prefix is a literal that covers every declared path of the receiver
      const mount=/\.use\s*\(\s*(['"])([^'"]*)\1\s*,\s*credentialGate\s*\(/.exec(text);
      if(!mount){add(9,ids,'receiver '+file+': the prefix of credentialGate is not a string literal');continue;}
      const prefix=mount[2].replace(/\/$/,'');
      for(const c of httpCalls.filter(c=>c.receiver.file===file&&c.receiver.gate===gate))
        for(const p of c.paths)if(p!==prefix&&!p.startsWith(prefix+'/'))add(9,c.id,'receiver '+file+': credentialGate guards \''+mount[2]+'\' but the declared path '+p+' of '+c.id+' is outside it');
      const route=/\bapp\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*(['"`])\/internal/.exec(text);
      if(route&&route.index<mount.index)add(9,ids,'receiver '+file+': a route is mounted before credentialGate, so it is not behind it');
    }
  }

  return result({calls,external,uncalled:uncalledRoutes,exceptions:timeoutExceptions,undeclared,httpFiles});
}
export const serviceCallFindings=(gatewayRoutes,today,io)=>analyzeCalls(gatewayRoutes,today,io).found.map(f=>f.text);

// For S13: the directions the declaration covers, and which of them have a finding on one of their calls. A direction is unchecked when
// it has no declared call or a call with a finding; an undeclared call site counts apart. Findings about exceptions (their date) carry
// no call, so the number does not move with the calendar.
export function serviceCallMetrics(gatewayRoutes,today,io){
  const a=analyzeCalls(gatewayRoutes,today,io);
  const directions=new Map(PLAN_DIRECTIONS.map(d=>[d,{ids:[],findings:0}]));
  for(const c of a.calls){
    const key=c.caller.service+'->'+c.callee.service;
    directions.set(key,directions.get(key)??{ids:[],findings:0});
    directions.get(key).ids.push(c.id);
  }
  const owner=new Map(a.calls.map(c=>[c.id,c.caller.service+'->'+c.callee.service]));
  for(const f of a.found)for(const id of new Set(f.call))if(owner.has(id))directions.get(owner.get(id)).findings++;
  const unchecked=[...directions].filter(([,v])=>v.ids.length===0||v.findings>0).length;
  return {
    uncheckedDirections:unchecked,
    undeclaredCallSites:a.undeclared.length,
    detail:{
      directions:[...directions].map(([direction,v])=>({direction,calls:v.ids,findings:v.findings})),
      external:a.external.map(x=>x.id+' ('+x.service+': '+x.file+')'),
      uncalledRoutes:a.uncalled.map(u=>u.callee+' '+u.method+' '+u.path),
      timeoutExceptions:a.exceptions.map(x=>x.outer+' > '+x.inner+' until '+x.until),
      undeclared:a.undeclared,
      findings:a.found.map(f=>f.text),
    },
  };
}
export const callExceptionDays=(today,io)=>{
  try{return (JSON.parse(io.read(DECLARATION)).timeoutExceptions??[]).map(x=>x.outer+' > '+x.inner+': '+daysLeft(today,x.until)+' days left');}catch{return [];}
};
