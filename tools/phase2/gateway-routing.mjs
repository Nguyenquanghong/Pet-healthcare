// Gateway routing (K5, ADR-P14 4.1): which service answers an /api path is declared once, in packages/contracts/src/gatewayRoutes.ts.
// This file reads every place that routes /api traffic (nginx configs, the E2E proxy, the Vite dev proxy, the frontend client), computes
// where each place sends a fixed set of probe paths, and compares that with the declared owner. It is shared by the rule
// gateway-routes-single-source (tools/phase2/check-architecture-rules.mjs) and by the metric S6 (tools/phase2/arch-metrics.mjs).
// Read-only, no dependencies.
//
// What the readers do:
//  - nginx: the text is tokenized and parsed the way ngx_conf_read_token does (a # opens a comment and a quote opens a string only at
//    the start of a token; `${name}` is one variable). The gateway server is the one whose `listen` has the place's port; exactly one
//    must. In it only the directives of SERVER_DIRECTIVES (plus location, if, limit_except, proxy_pass, return, try_files, error_page)
//    are accepted; a nested or named location, rewrite, include, a redirect, a proxy_pass in an `if`, an error_page or try_files that
//    jumps to /api, to a named location or to a proxied location, and a `${...}` of a JS template that the place does not list fail the
//    place. A core-ingress gateway may proxy to Core only. Locations are matched with the `u` flag, so a PCRE-only escape (\A, \Q) fails.
//    Directives at http level that the server inherits (mirror, auth_request, error_page, ...) are checked the same way.
//  - JS (E2E proxy, frontend client, Vite config): comments, strings, templates and regex literals are told apart before words are
//    counted; the E2E proxy and the frontend are read by counting uses and allowlisting the calls that are left.
// What they do not do (a finding is never raised for these, so they are the review's job):
//  - a `${headers}`, `${coreGateway}` or `${coreEdge}` (listed `as`, or outside the gateway server) is trusted by its name: the JS that
//    builds it is not read, and a coreEdge that holds a server on the gateway port is not seen (a conflicting listen is not an error in nginx);
//  - `ports`, `origins` and the env of a process may be reassigned or differ at run time: only the E2E proxy checks that `origins` is not
//    assigned, and the real value of an env variable is never read;
//  - an `upstream` block that points a name at another port (`upstream core { server 127.0.0.1:5101; }`) is parsed, not checked;
//  - nginx.exe on Windows matches locations without regard to case; the model here is nginx on Linux;
//  - the sweep sees `proxy_pass`, a `proxy: {` option, createProxyMiddleware, 'http-proxy' and fetch(...req.url) in one call, not
//    `new URL(req.url, host)` followed by `fetch(u)`, express-http-proxy, @fastify/http-proxy, or http.request(...).pipe(...);
//  - JSX text with an apostrophe or `//` can hide the rest of its line from the word counts.
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';

const GATEWAY_SPEC='backend/openapi.json';
const SERVICE_SPECS={clinic:'services/clinic/openapi.json',notification:'services/notification/openapi.json'};
const ROUTES_SOURCE='packages/contracts/src/gatewayRoutes.ts';
const CORE_ROUTES='backend/src/composition/coreRoutes.ts';
const CORE_APP='backend/src/composition/coreApp.ts';
const MAX_DAYS=60;
const SERVICES=['core','clinic','notification'];

// The places. `topology` is a key of gatewayTopologies: core-ingress sends every /api path to Core; direct sends each owned prefix
// straight to its service. `template` picks the nginx text out of a JS file (exactly one match; `outsideProxyPass` proxy_pass
// elsewhere in the file are allowed, for text the reader does not follow); `port` picks the server block by its `listen` port (a number
// or a listed `${...}`); `interp` lists the `${...}` of a JS template that may appear in the gateway server (`as`: the nginx text the
// reader parses in its place, none = the `${...}` itself); `targets` turns a proxy_pass argument into a service.
const PAUSED=String.raw`paused?'if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {return 503 \'{"error":"Migration maintenance; retry later."}\';}':''`;
const PAUSED_AS=String.raw`if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {return 503 '{"error":"Migration maintenance; retry later."}';}`;
export const ROUTING_PLACES=[
  {id:'frontend/nginx/default.conf.template',kind:'nginx',topology:'core-ingress',port:'8080',targets:[[/^http:\/\/api:\$\{API_PORT\}$/,'core']]},
  {id:'deploy/phase2/nginx.split.conf.example',kind:'nginx',topology:'direct',port:'8080',targets:[[/^http:\/\/core$/,'core'],[/^http:\/\/clinic$/,'clinic'],[/^http:\/\/notification$/,'notification']]},
  {id:'benchmarks/phase2/kaggle/stack.mjs',kind:'nginx',topology:'direct',template:/const config=`([^`]*)`/,outsideProxyPass:1,port:'${ports.gateway}',interp:[{expr:'ports.gateway'},{expr:'headers',as:''},{expr:'coreGateway',as:''},{expr:'origins.notification'}],targets:[[/^http:\/\/core$/,'core'],[/^http:\/\/clinic$/,'clinic'],[/^\$\{origins\.notification\}$/,'notification']]},
  {id:'tools/phase2/resilience.test.mjs',kind:'nginx',topology:'direct',template:/const config=`([^`]*)`/,port:'${edge}',interp:[{expr:'edge'},{expr:'n'}],targets:[[/^http:\/\/core$/,'core'],[/^http:\/\/clinic$/,'clinic'],[/^http:\/\/127\.0\.0\.1:\$\{n\}$/,'notification']]},
  {id:'tools/phase2/p7-rehearsal.test.mjs',kind:'nginx',topology:'core-ingress',template:/const config=`([^`]*)`/,port:'${ports.gateway}',interp:[{expr:'ports.gateway'},{expr:'upstream'},{expr:'marker',as:'m'},{expr:PAUSED,as:PAUSED_AS}],targets:[[/^\$\{upstream\}$/,'core']]},
  {id:'tools/phase2/e2e-server.mjs',kind:'js-proxy',topology:'core-ingress'},
  {id:'frontend/src/services/apiClient.ts',kind:'frontend',topology:'core-ingress'},
  {id:'frontend/vite.config.ts',kind:'vite',topology:'core-ingress'},
];
// A place may differ from its topology for a reason and until a date (UTC, inclusive; the day after, the rule fails; at most 60 days
// ahead). The prefix is one of gatewayRoutes and routesTo a service. An exception that no longer differs is stale and fails as well.
export const ROUTING_EXCEPTIONS=[
  {place:'benchmarks/phase2/kaggle/stack.mjs',prefix:'/api/dashboard/clinic',routesTo:'core',until:'2026-11-20',reason:'The bridge study measured /api/dashboard/clinic through Core and the H-M numbers were taken that way; K9 changes the harness (H3 direct, H3c through Core) and this exception goes stale (ADR-P14 4.1, K5 Q3).'},
];
// Files with a proxy that are not places: text that only quotes a config, or a hop that is not the /api gateway. An entry with
// `until` is a debt: after that date it fails like an exception; one that no longer holds a proxy is stale; `only` narrows it to the
// one proxy it names (a second one fails); a file is listed once.
export const PROXY_SWEEP_IGNORE=[
  {file:'tools/phase2/check-architecture-rules.mjs',reason:'the rule and its fixtures'},
  {file:'tools/phase2/gateway-routing.mjs',reason:'the reader and its patterns'},
  {file:'tools/phase2/billing.test.mjs',only:'fetch(clinicBases[0]+req.url',reason:'a stand-in for the private Core to Clinic billing hop (CLINIC_SERVICE_URL), which carries no /api gateway traffic'},
  {file:'benchmarks/phase2/kaggle/test_bridge_study.py',reason:'locks the text of stack.mjs; K9 rewrites both together',until:'2026-11-20'},
];

// ---- JS text ----------------------------------------------------------------------------
// Index after the string or template literal that opens at i; a quote string stops at the line end.
export function jsStringEnd(text,i){
  const q=text[i];
  for(let j=i+1;j<text.length;j++){
    const c=text[j];
    if(c==='\\'){j++;continue;}
    if(q==='`'&&c==='$'&&text[j+1]==='{'){const end=jsBraceEnd(text,j+2);if(end<0)return text.length;j=end;continue;}
    if(c===q)return j+1;
    if(c==='\n'&&q!=='`')return j;
  }
  return text.length;
}
// Index of the } that closes a { whose body starts at `from`; -1 when it never closes.
export function jsBraceEnd(text,from){
  for(let i=from,depth=1;i<text.length;i++){
    const c=text[i];
    if(c==="'"||c==='"'||c==='`'){i=jsStringEnd(text,i)-1;continue;}
    if(c==='{')depth++;
    else if(c==='}'&&--depth===0)return i;
  }
  return -1;
}
const blank=text=>text.replace(/[^\n]/g,' ');
// A / opens a regex literal after one of these characters or words, and divides after anything else.
const regexMayStart=(prev,out)=>prev===''||/[(,=:[!&|?{};+*%<>~^-]/.test(prev)||/(?:^|[^\w$.])(?:return|typeof|case|else|do|in|of|yield|await|void|delete|throw|new)\s*$/.test(out);
function regexEnd(text,i){
  let inClass=false;
  for(let j=i+1;j<text.length;j++){
    const c=text[j];
    if(c==='\\'){j++;continue;}
    if(c==='\n')return j;
    if(c==='[')inClass=true;
    else if(c===']')inClass=false;
    else if(c==='/'&&!inClass)return j+1;
  }
  return text.length;
}
function maskTemplate(text,i,end){
  let out='`';
  for(let j=i+1;j<end;j++){
    const c=text[j];
    if(c==='\\'){out+=' '+(text[j+1]===undefined||j+1>=end?'':text[j+1]==='\n'?'\n':' ');j++;continue;}
    if(c==='$'&&text[j+1]==='{'){
      const close=jsBraceEnd(text,j+2);
      if(close<0||close>=end){out+=blank(text.slice(j,end));break;}
      out+='${'+scanJs(text.slice(j+2,close),true)+'}';j=close;continue;
    }
    out+=c==='\n'?'\n':j===end-1&&c==='`'?'`':' ';
  }
  return out;
}
// The text with comments blanked (spaces, newlines kept, so every offset stays); `mask` also blanks what is inside strings, templates
// (their `${...}` stay code) and regex literals, so only code is left to match words against.
function scanJs(text,mask){
  let out='',prev='';
  for(let i=0;i<text.length;){
    const c=text[i],n=text[i+1];
    if(c==="'"||c==='"'||c==='`'){
      const end=jsStringEnd(text,i);
      if(!mask)out+=text.slice(i,end);
      else if(c==='`')out+=maskTemplate(text,i,end);
      else out+=c+' '.repeat(Math.max(0,end-i-2))+(end-i>=2&&text[end-1]===c?c:' ');
      prev=c;i=end;continue;
    }
    if(c==='/'&&n==='/'){let j=i;while(j<text.length&&text[j]!=='\n')j++;out+=' '.repeat(j-i);i=j;continue;}
    if(c==='/'&&n==='*'){const e=text.indexOf('*/',i+2),j=e<0?text.length:e+2;out+=blank(text.slice(i,j));i=j;continue;}
    if(c==='/'&&regexMayStart(prev,out)){
      const end=regexEnd(text,i);
      out+=mask?'/'+' '.repeat(end-i-1):text.slice(i,end);
      prev=')';i=end;continue;
    }
    out+=c;
    if(!/\s/.test(c))prev=c;
    i++;
  }
  return out;
}
export const stripJsComments=text=>scanJs(text,false);
export const maskJs=text=>scanJs(text,true);
// The arguments of the call whose "(" is at `open`, each as source text; `end` is the index of the closing ")".
export function callArguments(code,open){
  const args=[];
  let depth=0,from=open+1;
  for(let i=open+1;i<code.length;i++){
    const c=code[i];
    if(c==="'"||c==='"'||c==='`'){i=jsStringEnd(code,i)-1;continue;}
    if(c==='('||c==='['||c==='{')depth++;
    else if(c===')'||c===']'||c==='}'){if(depth===0){args.push(code.slice(from,i));return {args,end:i};}depth--;}
    else if(c===','&&depth===0){args.push(code.slice(from,i));from=i+1;}
  }
  return {args:[code.slice(from)],end:-1};
}
// Every call fetch( (also window.fetch, globalThis.fetch) in code, not in a string or comment, with its first argument, whitespace removed.
export function fetchCalls(code){
  const masked=maskJs(code);
  return [...masked.matchAll(/(?<![\w$])fetch\s*\(/g)].map(m=>({index:m.index,arg:(callArguments(code,m.index+m[0].length-1).args[0]??'').replace(/\s+/g,'')}));
}
// Every use of the global fetch in code: `fetch`, `window.fetch`, `globalThis.fetch`; not a string, a comment, a key (`{ fetch: x }`) or `obj.fetch`.
export function fetchUses(code){
  const masked=maskJs(code);
  return [...masked.matchAll(/(?:\b(?:globalThis|window|self)\s*\??\.\s*|(?<![\w$.]))fetch(?![\w$])/g)]
    .filter(m=>!(/^\s*:/.test(masked.slice(m.index+m[0].length))&&/[{,]$/.test(masked.slice(0,m.index).trimEnd())))
    .map(m=>m.index);
}
// The body of `function name(...) {...}`, with its start offset in the code; null when it is not there.
export function functionBody(code,name){
  const head=new RegExp('\\bfunction\\s+'+name+'\\s*\\(').exec(code);
  if(!head)return null;
  const params=callArguments(code,head.index+head[0].length-1);
  const open=params.end<0?-1:code.indexOf('{',params.end);
  const close=open<0?-1:jsBraceEnd(code,open+1);
  return close<0?null:{start:open+1,end:close,text:code.slice(open+1,close)};
}
const joinStrings=code=>code.replace(/(['"`])\s*\+\s*['"`]/g,'');
const escapeRe=text=>text.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&');
const prefixRe=prefix=>new RegExp(escapeRe(prefix)+'(?![\\w-])','g');

// ---- nginx text -----------------------------------------------------------------------
// `${...}` as a JS template writes it: [{start,end,expr}], end after the closing brace.
export function interpolations(text){
  const out=[];
  for(let i=0;i<text.length;i++){
    if(text[i]!=='$'||text[i+1]!=='{')continue;
    const end=jsBraceEnd(text,i+2);
    if(end<0)throw new Error('a ${ is not closed');
    out.push({start:i,end:end+1,expr:text.slice(i+2,end)});
    i=end;
  }
  return out;
}
const POISON='\u0001';
// A listed `${...}` stays as written (or becomes its `as` text); any other becomes a directive named POISON, which the gateway server refuses.
export function substituteInterpolations(text,allowed){
  const known=new Map(allowed.map(e=>[e.expr,e]));
  let out='',last=0;
  for(const m of interpolations(text)){
    const entry=known.get(m.expr.trim());
    out+=text.slice(last,m.start)+(entry?(entry.as===undefined?'${'+m.expr+'}':' '+entry.as+' '):' '+POISON+'; ');
    last=m.end;
  }
  return out+text.slice(last);
}
const NGINX_ESCAPES={'"':'"',"'":"'",'\\':'\\',t:'\t',r:'\r',n:'\n'};
// As ngx_conf_read_token: a # at the start of a token opens a comment to the line end; a quote at the start of a token opens a string
// (a backslash escapes inside it); elsewhere # and quotes are text; `${name}` is one variable; `;` and `{` end a word, `}` only starts a token.
export function nginxTokens(text){
  const out=[];
  for(let i=0;i<text.length;){
    const c=text[i];
    if(/\s/.test(c)){i++;continue;}
    if(c==='#'){while(i<text.length&&text[i]!=='\n')i++;continue;}
    if(c===';'||c==='{'||c==='}'){out.push({t:c});i++;continue;}
    if(c==="'"||c==='"'){
      let j=i+1,value='';
      for(;j<text.length&&text[j]!==c;j++){
        if(text[j]==='\\'&&j+1<text.length){j++;value+=text[j] in NGINX_ESCAPES?NGINX_ESCAPES[text[j]]:'\\'+text[j];}
        else value+=text[j];
      }
      if(j>=text.length)throw new Error('a quote is not closed');
      if(!/[\s;{]/.test(text[j+1]??' '))throw new Error('text right after a closing quote');
      out.push({t:'w',v:value});i=j+1;continue;
    }
    let j=i;
    while(j<text.length&&!/[\s;{]/.test(text[j])){
      if(text[j]==='$'&&text[j+1]==='{'){const close=text.indexOf('}',j);if(close<0)throw new Error('a ${ is not closed');j=close+1;}
      else j++;
    }
    out.push({t:'w',v:text.slice(i,j)});i=j;
  }
  return out;
}
// The directives of a conf as a tree: {name,args,children?}; throws on a block that is not closed or a directive with no `;`.
export function parseNginx(conf){
  const tokens=nginxTokens(conf);
  let pos=0;
  const block=top=>{
    const out=[];
    for(;;){
      if(pos>=tokens.length){if(!top)throw new Error('a { is not closed');return out;}
      if(tokens[pos].t==='}'){if(top)throw new Error('a } with no { before it');pos++;return out;}
      const words=[];
      while(tokens[pos]?.t==='w')words.push(tokens[pos++].v);
      const end=tokens[pos++];
      if(!end||end.t==='}')throw new Error('a directive has no ; ('+words.slice(0,3).join(' ')+')');
      if(end.t===';'){if(words.length)out.push({name:words[0],args:words.slice(1)});continue;}
      if(!words.length)throw new Error('a { with no directive before it');
      out.push({name:words[0],args:words.slice(1),children:block(false)});
    }
  };
  return block(true);
}
const walkNginx=(nodes,visit)=>{for(const n of nodes){visit(n);if(n.children)walkNginx(n.children,visit);}};
// nginx reads a location's modifier from the first argument, with or without a space after it.
export function locationName(args){
  if(args.length===1){
    const a=args[0];
    if(a.startsWith('@'))throw new Error('location '+a+' (a named location is a second route)');
    for(const modifier of ['^~','~*','=','~'])if(a.startsWith(modifier))return {modifier,path:a.slice(modifier.length)};
    return {modifier:'',path:a};
  }
  if(args.length===2&&['=','^~','~','~*'].includes(args[0]))return {modifier:args[0],path:args[1]};
  throw new Error('location with arguments nginx does not accept: '+args.join(' '));
}
// The port of a listen argument: 8080, 127.0.0.1:8080, *:8080, [::]:8080, localhost:8080, ${port}; null when it has none.
export function listenPort(arg){
  if(arg===undefined||arg.startsWith('unix:'))return null;
  if(/^\d+$/.test(arg)||/^\$\{[^}]*\}$/.test(arg))return arg;
  return /:([^:\]\s]+)$/.exec(arg)?.[1]??null;
}
const serversOf=nodes=>nodes.flatMap(n=>n.name==='server'&&n.children?[n]:n.name==='http'&&n.children?serversOf(n.children):[]);
const portsOf=server=>server.children.filter(n=>n.name==='listen').map(n=>listenPort(n.args[0]));
const poisoned=n=>n.name.includes(POISON)||n.args.some(a=>a.includes(POISON));
// The directives the gateway server may hold besides the ones that get their own rule below. Taken from the five nginx places (listen,
// server_name, root, index, client_max_body_size, proxy_set_header and the proxy timeouts, add_header, expires, default_type) plus
// common ones that do not change which upstream answers. Anything else (mirror, auth_request, a map-driven set, proxy_cache...) fails.
const SERVER_DIRECTIVES=/^(?:listen|server_name|root|index|client_max_body_size|client_body_buffer_size|client_body_timeout|keepalive_timeout|default_type|charset|server_tokens|expires|add_header|gzip(?:_\w+)?|access_log|error_log|set|deny|allow|internal|proxy_set_header|proxy_hide_header|proxy_http_version|proxy_(?:connect|read|send)_timeout|proxy_next_upstream(?:_\w+)?|proxy_buffering|proxy_buffers|proxy_buffer_size|proxy_busy_buffers_size|proxy_request_buffering|proxy_pass_request_headers)$/;
// At http level (inherited by the server) these change routing; error_page is read like the server's.
const HTTP_ROUTING_DIRECTIVES=new Set(['mirror','auth_request','rewrite','proxy_pass','try_files','return','if','location']);
// An error_page or try_files that jumps to a URI: static, in the server, outside /api, and not into a proxied location (checked later).
const staticJump=(uri,what)=>{
  if(!uri.startsWith('/')||/^\/api(\/|$)/i.test(uri))throw new Error(what+' jumps to '+uri+' (only a static URI outside /api is followed)');
  return uri;
};
const errorPageUri=n=>{if(n.args.length<2)throw new Error('error_page with no URI');return staticJump(n.args.at(-1),'error_page');};
// The locations of the gateway server, in order of appearance, after the refusals the header names.
function serverLocations(server,jumps){
  const locations=[];
  const visit=(nodes,context,targets)=>{
    for(const n of nodes){
      if(poisoned(n))throw new Error('a ${...} that the place does not list (ROUTING_PLACES interp) in the gateway server');
      switch(n.name){
        case 'rewrite':throw new Error('rewrite in the gateway server: it moves a request to another location');
        case 'error_page':jumps.push(errorPageUri(n));break;
        case 'proxy_pass':
          if(context!=='location')throw new Error('proxy_pass in '+context+', not directly in a location');
          if(n.args.length!==1||targets.length)throw new Error('a location with more than one proxy_pass argument');
          targets.push(n.args[0]);
          break;
        case 'return':
          if((n.args.length===1?!/^\d{3}$/.test(n.args[0]):/^3\d\d$/.test(n.args[0]))&&context!=='location')throw new Error('a return redirect in '+context);
          break;
        case 'try_files':{
          const last=n.args.at(-1)??'';
          if(last.startsWith('@'))throw new Error('try_files falls back to the named location '+last);
          if(last.startsWith('/'))jumps.push(staticJump(last,'try_files'));
          break;
        }
        case 'location':{
          // A nested location could change which service answers a prefix; none exists, so none is followed.
          if(context!=='server')throw new Error('a location inside '+context+' (nested location)');
          if(!n.children)throw new Error('a location with no block');
          const found=[],location=locationName(n.args);
          visit(n.children,'location',found);
          if(location.modifier==='~'||location.modifier==='~*')new RegExp(location.path,location.modifier==='~*'?'iu':'u');
          locations.push({...location,target:found[0]??null});
          break;
        }
        case 'if':case 'limit_except':
          if(!n.children)throw new Error(n.name+' with no block');
          visit(n.children,n.name==='if'?'an if':'a limit_except block',targets);
          break;
        default:
          if(n.children||!SERVER_DIRECTIVES.test(n.name))throw new Error('the directive '+n.name+(n.children?' (a block)':'')+' is not one the reader follows in the gateway server (SERVER_DIRECTIVES)');
      }
    }
  };
  visit(server.children,'server',[]);
  return locations;
}
// The locations of the one server block whose `listen` has this port, in order of appearance.
export function nginxLocations(conf,port){
  const tree=parseNginx(conf),jumps=[];
  walkNginx(tree,n=>{if(n.name==='include')throw new Error('include: the text it brings in is not read');});
  for(const n of tree.flatMap(t=>t.name==='http'&&t.children?t.children:[t])){
    if(n.name==='server'||n.name==='http')continue;
    if(HTTP_ROUTING_DIRECTIVES.has(n.name))throw new Error('the directive '+n.name+' above the server (it is inherited)');
    if(n.name==='error_page')jumps.push(errorPageUri(n));
  }
  const servers=serversOf(tree).filter(s=>portsOf(s).includes(port));
  if(servers.length!==1)throw new Error(servers.length+' server blocks listen on '+port+' (exactly one expected)');
  const locations=serverLocations(servers[0],jumps);
  for(const uri of jumps){const into=nginxRoute(locations,uri);if(into?.target)throw new Error('a jump to '+uri+' lands in a proxied location ('+into.path+')');}
  return locations;
}
// nginx's choice: an exact `=` match; else the longest matching prefix, which wins at once when it is `^~`; else the first
// regex (`~` case-sensitive, `~*` not) that matches, in order of appearance; else that longest prefix; else nothing.
export function nginxRoute(locations,pathname){
  const exact=locations.find(l=>l.modifier==='='&&l.path===pathname);
  if(exact)return exact;
  let best=null;
  for(const l of locations)if((l.modifier===''||l.modifier==='^~')&&pathname.startsWith(l.path)&&(!best||l.path.length>best.path.length))best=l;
  if(best?.modifier==='^~')return best;
  for(const l of locations)if((l.modifier==='~'||l.modifier==='~*')&&new RegExp(l.path,l.modifier==='~*'?'iu':'u').test(pathname))return l;
  return best;
}
const serviceOfLocation=(targets,location)=>{
  if(!location||location.target===null)return 'none';
  return targets.find(([re])=>re.test(location.target))?.[1]??'unknown '+location.target;
};
export const routingTable=(locations,probes,targets)=>Object.fromEntries(probes.map(p=>[p,serviceOfLocation(targets,nginxRoute(locations,p))]));

// ---- probes ---------------------------------------------------------------------------
const placeholders=path=>path.replace(/\{[^}]*\}/g,'x');
const UUID='123e4567-e89b-12d3-a456-426614174000';
const METHODS=['get','post','put','patch','delete'];
export function gatewayPaths(spec){
  return Object.entries(spec.paths).map(([path,item])=>({path:'/api'+path,methods:METHODS.filter(m=>m in item)}));
}
export function probesOf(contracts,paths){
  const out=new Set();
  const tails=['','/','/x','/x/y','/1','/'+UUID];
  for(const base of ['/api/pets','/api/vaccinations'])for(const tail of tails)out.add(base+tail);
  for(const {prefix} of contracts.gatewayRoutes){
    const upper=prefix.replace(/\/api\/(\w)/,(_,c)=>'/api/'+c.toUpperCase());
    for(const base of [prefix,upper,prefix.toUpperCase().replace('/API/','/api/')])for(const tail of tails)out.add(base+tail);
    out.add(prefix+'x');
    out.add(prefix+'-x');
  }
  for(const {path} of paths){
    out.add(placeholders(path));
    out.add(path.replace(/\{[^}]*\}/g,'1'));
    out.add(path.replace(/\{[^}]*\}/g,UUID));
    const segment=placeholders(path).split('/')[2];
    out.add('/api/'+segment);
    out.add('/api/'+segment+'/x');
  }
  return [...out];
}

// ---- reading the places ------------------------------------------------------------------
// In a JS template `\n`, `\'`, `\"`, a backtick and `\\` are escapes; other backslashes stay (regex classes).
const unescapeJs=text=>text.replace(/\\([\s\S])/g,(m,c)=>c==='n'?'\n':"'\"`\\".includes(c)?c:m);
const count=(text,re)=>(text.match(re)??[]).length;
const nginxPlace=(place,text,probes)=>{
  let conf=text;
  if(place.template){
    const found=[...text.matchAll(new RegExp(place.template.source,place.template.flags.replace('g','')+'g'))];
    if(found.length!==1)throw new Error('exactly one nginx template expected in the file (found '+found.length+')');
    const outside=count(text,/\bproxy_pass\b/g)-count(found[0][1],/\bproxy_pass\b/g);
    if(outside!==(place.outsideProxyPass??0))throw new Error(outside+' proxy_pass outside the template that is read (expected '+(place.outsideProxyPass??0)+')');
    conf=unescapeJs(substituteInterpolations(found[0][1],place.interp??[]));
  }
  const locations=nginxLocations(conf,place.port);
  if(locations.length<1)throw new Error('the server block has no location');
  if(place.topology==='core-ingress')for(const l of locations)if(l.target!==null&&serviceOfLocation(place.targets,l)!=='core')throw new Error('location '+l.path+' proxies to '+l.target+', not to Core, in a core-ingress gateway');
  return routingTable(locations,probes,place.targets);
};
const allCore=probes=>Object.fromEntries(probes.map(p=>[p,'core']));
// The one fetch the E2E server makes outside its /api/ branch: a readiness probe of a started service.
const E2E_OTHER_FETCH="origins[name]+'/health/ready'";
const jsProxyPlace=(place,text,probes)=>{
  const code=stripJsComments(text),masked=maskJs(code);
  const branches=[...code.matchAll(/\.startsWith\(\s*(['"])\/api\/\1\s*\)\s*\)\s*\{/g)];
  if(branches.length!==1)throw new Error('exactly one if(…startsWith(\'/api/\')) {…} branch expected (found '+branches.length+')');
  const open=branches[0].index+branches[0][0].length-1,close=jsBraceEnd(code,open+1);
  if(close<0)throw new Error('the /api/ branch is not closed');
  const inside=code.slice(open+1,close),outside=code.slice(0,open+1)+' '.repeat(close-open-1)+code.slice(close);
  const calls=fetchCalls(inside);
  if(calls.length!==1)throw new Error('the /api/ branch must hold exactly one fetch( (found '+calls.length+')');
  if(!/^(?:origins(?:\.core|\['core'\]|\["core"\])\+req\.url|`\$\{origins\.core\}\$\{req\.url\}`)$/.test(calls[0].arg))throw new Error('the /api/ branch forwards to '+calls[0].arg+', not origins.core + req.url');
  if((inside.match(/\breq\.(?:url|originalUrl)\b/g)??[]).length!==1)throw new Error('the /api/ branch uses req.url more than once');
  for(const other of fetchCalls(outside))if(other.arg!==E2E_OTHER_FETCH)throw new Error('a fetch( outside the /api/ branch that is not the readiness probe: fetch('+other.arg+')');
  for(const m of outside.matchAll(/\breq\.(?:url|originalUrl)\b/g))if(!outside.slice(0,m.index).endsWith('new URL('))throw new Error('req.url is used outside the /api/ branch other than in new URL(req.url, …)');
  if(/\b(?:https?|http2)\s*\.\s*(?:request|get)\s*\(|\.pipe\s*\(|\bpipeline\s*\(/.test(masked)||/import\s*\{[^}]*\b(?:request|get)\b[^}]*\}\s*from\s*['"](?:node:)?https?['"]/.test(code))throw new Error('another way to forward a request (http.request, .pipe, pipeline)');
  if(/\borigins\s*(?:\.\w+|\[[^\]]*\])\s*=(?!=)|Object\.assign\(\s*origins\b/.test(masked))throw new Error('origins is assigned after it is built');
  return allCore(probes);
};
const BASE_LITERALS=['http://localhost:5000/api','/api',''];
const frontendPlace=(place,text,probes,io,routes)=>{
  const sources=io.list('frontend').map(file=>{const code=stripJsComments(io.read(file));return {file,code,masked:maskJs(code)};});
  const fetches=sources.flatMap(({file,masked})=>fetchUses(masked).map(()=>file));
  if(fetches.length!==1||fetches[0]!==place.id)throw new Error('exactly one use of fetch in frontend/src, in '+place.id+' (found '+fetches.length+': '+[...new Set(fetches)].join(', ')+')');
  for(const {file,masked} of sources){
    const sink=masked.match(/\b(?:XMLHttpRequest|sendBeacon|WebSocket|EventSource|axios|importScripts)\b|\bnew\s+Request\b/);
    if(sink)throw new Error('another way to reach the network: '+file+' uses '+sink[0]);
    if(/\b(?:globalThis|window|self)\s*(?:as\s+\w+\s*)?\)?\s*\[/.test(masked))throw new Error(file+' reads a member of the global object by a computed key');
    if(/import\.meta\.env\s*\[/.test(masked))throw new Error(file+' reads import.meta.env by a computed key');
  }
  // Only the names that can carry an origin matter: VITE_APP_TITLE is not one.
  const names=new Set(sources.flatMap(({masked})=>masked.match(/\bVITE_\w+/g)??[]));
  const origins=[...names].filter(n=>/URL|ORIGIN|BASE|HOST|ENDPOINT/.test(n)&&n!=='VITE_API_BASE_URL');
  if(origins.length||!names.has('VITE_API_BASE_URL'))throw new Error('VITE_API_BASE_URL is the one origin variable (found '+[...names].join(', ')+')');
  const ports=new Set(sources.flatMap(({code})=>[...code.matchAll(/(?:localhost|127\.0\.0\.1):(\d+)/g)].map(m=>m[1])));
  if([...ports].some(p=>p!=='5000'&&p!=='5173'))throw new Error('a service port besides Core 5000: '+[...ports].join(', '));
  for(const {file,code} of sources){
    for(const url of code.match(/https?:\/\/[^'"`\s)]*/g)??[]){
      if(file===place.id){if(!url.startsWith('http://localhost:5000'))throw new Error(file+' names a second origin: '+url);}
      else if(/^https?:\/\/[^/]+\/api(?:[/?#]|$)/.test(url))throw new Error(file+' names an /api URL: '+url);
    }
    for(const {prefix} of routes)if(prefixRe(prefix).test(code))throw new Error(file+' names '+prefix+'; the frontend reaches every service through one base URL');
  }
  const code=sources.find(s=>s.file===place.id).code;
  const declaration=[...code.matchAll(/\bconst\s+API_BASE_URL\s*=([^;]*);/g)];
  if(declaration.length!==1||count(code,/\bAPI_BASE_URL\s*=(?!=)/g)!==1)throw new Error('API_BASE_URL must be declared once, with const');
  const literals=[...declaration[0][1].matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m=>m[2]);
  if(literals.some(l=>!BASE_LITERALS.includes(l))||!literals.includes('/api'))throw new Error('API_BASE_URL may name only '+BASE_LITERALS.filter(Boolean).join(' and ')+' (found '+literals.join(', ')+')');
  const [call]=fetchCalls(code);
  if(!call.arg.startsWith('`${API_BASE_URL}'))throw new Error('the fetch does not start from API_BASE_URL: fetch('+call.arg.slice(0,60)+')');
  return allCore(probes);
};
const vitePlace=(place,text,probes)=>{
  const code=stripJsComments(text);
  if(/createProxyMiddleware|['"]http-proxy(?:-middleware)?['"]|configureServer|configurePreviewServer|middlewares/.test(code))throw new Error('a proxy written as code (createProxyMiddleware, http-proxy or a server hook)');
  const opens=[...code.matchAll(/['"]?\bproxy['"]?\s*:\s*\{/g)];
  if(opens.length!==1)throw new Error('exactly one proxy: { … } expected (found '+opens.length+')');
  const open=opens[0].index+opens[0][0].length-1,close=jsBraceEnd(code,open+1);
  if(close<0)throw new Error('the proxy object is not closed');
  const body=code.slice(open+1,close),entry=/(['"])([^'"]+)\1\s*:\s*(['"])([^'"]+)\3/g;
  const entries=[...body.matchAll(entry)].map(m=>[m[2],m[4]]);
  if(body.replace(entry,'').replace(/[\s,]/g,'')!=='')throw new Error('the proxy has a shape this reader does not know (only "path": "origin" entries)');
  if(entries.length!==1||entries[0][0]!=='/api'||entries[0][1]!=='http://localhost:5000')throw new Error('the dev proxy must be exactly "/api" -> http://localhost:5000 (found '+entries.map(e=>e.join(' -> ')).join(', ')+')');
  return allCore(probes);
};
const READERS={nginx:nginxPlace,'js-proxy':jsProxyPlace,frontend:frontendPlace,vite:vitePlace};

// ---- io -----------------------------------------------------------------------------------
const SWEEP_MAX=2*1024*1024;
// The lists of files the readers walk. `dir` is where the walk starts; a file is in the list when its name has the extension and no
// directory name of its path (or its own name) is in skipNames and no skipPaths entry is a prefix of its path. realIo walks the disk with
// these; fixtureIo adds the fixture files that `listed` accepts, so a fixture goes through the same filter as a real file.
const LISTS={
  // Everything a proxy could hide in. phase2-plan/evidence holds frozen copies of files that are checked live.
  sweep:{dir:'',skipNames:new Set(['node_modules','dist','.git','test-results','Results','coverage','generated','__pycache__','.claude']),skipPaths:new Set(['phase2-plan/evidence']),ext:/\.(mjs|cjs|js|ts|tsx|json|ya?ml|conf|example|template|py|sh)$/},
  // The frontend client is every script under frontend/src, generated types included.
  frontend:{dir:'frontend/src',skipNames:new Set(['node_modules']),skipPaths:new Set(),ext:/\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/},
};
export function listFiles(root,list,fs={readdirSync,statSync}){
  const out=[];
  const walk=rel=>{
    for(const e of fs.readdirSync(join(root,rel),{withFileTypes:true})){
      const child=rel?rel+'/'+e.name:e.name;
      if(list.skipNames.has(e.name))continue;
      if(e.isDirectory()){if(!list.skipPaths.has(child))walk(child);}
      else if(list.ext.test(e.name)&&fs.statSync(join(root,child)).size<=SWEEP_MAX)out.push(child);
    }
  };
  walk(list.dir);
  return out;
}
export const sweepFiles=(root,fs)=>listFiles(root,LISTS.sweep,fs);
const listed=(rel,list)=>{
  const parts=rel.split('/');
  return (list.dir===''||rel.startsWith(list.dir+'/'))&&list.ext.test(parts.at(-1))&&!parts.some(p=>list.skipNames.has(p))&&![...list.skipPaths].some(p=>rel.startsWith(p+'/'));
};
export function realIo(root){
  const cache=new Map(),lists=new Map();
  const list=kind=>lists.get(kind)??(lists.set(kind,listFiles(root,LISTS[kind])),lists.get(kind));
  return {
    read:path=>cache.get(path)??(cache.set(path,readFileSync(resolve(root,path),'utf8')),cache.get(path)),
    list,
    sweep:()=>list('sweep'),
    places:ROUTING_PLACES,
    exceptions:ROUTING_EXCEPTIONS,
    ignore:PROXY_SWEEP_IGNORE,
  };
}
// The same io with some files' text replaced (a fixture) and, optionally, other values (exceptions, ignore) swapped.
export function fixtureIo(io,files={},extra={}){
  const list=kind=>[...new Set([...io.list(kind),...Object.keys(files).filter(f=>listed(f,LISTS[kind]))])];
  return {...io,...extra,read:path=>path in files?files[path]:io.read(path),list,sweep:()=>list('sweep')};
}

// ---- analysis ------------------------------------------------------------------------------
// A proxy: nginx's proxy_pass, a Vite or Node proxy library, or a fetch of the request's own URL.
const PROXY=/\bproxy_pass\b|['"]?\bproxy['"]?\s*:\s*\{|createProxyMiddleware|['"]http-proxy(?:-middleware)?['"]|\bfetch\s*\([^)]*\breq\.(?:url|originalUrl)\b/;
const PROXY_ALL=new RegExp(PROXY.source,'g');
export function analyze(contracts,io){
  const spec=JSON.parse(io.read(GATEWAY_SPEC)),paths=gatewayPaths(spec),probes=probesOf(contracts,paths);
  const errors=[],tables={},diffs={};
  for(const place of io.places){
    let table;
    try{
      table=READERS[place.kind](place,io.read(place.id),probes,io,contracts.gatewayRoutes);
      if(table['/api/pets']!=='core')throw new Error('/api/pets goes to '+table['/api/pets']+', not core');
    }catch(error){
      errors.push('fail-closed '+place.id+': '+error.message);
      table=Object.fromEntries(probes.map(p=>[p,'unreadable']));
    }
    tables[place.id]=table;
    diffs[place.id]=probes.filter(p=>table[p]!==(place.topology==='direct'?contracts.routeOwner(p):'core')).map(p=>({probe:p,actual:table[p],expected:place.topology==='direct'?contracts.routeOwner(p):'core'}));
  }
  const placeIds=new Set(io.places.map(p=>p.id)),ignored=new Set(io.ignore.map(e=>e.file));
  const unlisted=io.sweep().filter(f=>!placeIds.has(f)&&!ignored.has(f)&&PROXY.test(io.read(f)));
  const variants=new Set(Object.values(tables).map(t=>JSON.stringify(probes.map(p=>t[p])))).size;
  return {probes,paths,spec,errors,tables,diffs,unlisted,variants};
}

const daysLeft=(today,until)=>Math.round((Date.parse(until)-Date.parse(today))/864e5);
const isDate=text=>{
  if(!/^\d{4}-\d\d-\d\d$/.test(text??''))return false;
  const date=new Date(text+'T00:00:00Z');
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===text;
};
// The date of an exception or of a sweep ignore: a real day, not past (UTC, the last day counts), at most MAX_DAYS ahead.
const untilFindings=(tag,until,today)=>{
  if(!isDate(until))return [tag+'until is not a date (YYYY-MM-DD)'];
  if(today>until)return [tag+'expired on '+until+' ('+(-daysLeft(today,until))+' days ago); fix it or renew with a reason'];
  if(daysLeft(today,until)>MAX_DAYS)return [tag+'until '+until+' is more than '+MAX_DAYS+' days away'];
  return [];
};
export function exceptionFindings(analysis,io,today,contracts){
  const findings=[],covered=new Set(),seen=new Set();
  for(const ex of io.exceptions){
    const tag='exception '+ex.place+' '+ex.prefix+': ';
    if(typeof ex.reason!=='string'||ex.reason.trim().length<10)findings.push(tag+'no reason');
    if(!io.places.some(p=>p.id===ex.place)){findings.push(tag+'place not found in the routing places');continue;}
    if(!contracts.gatewayRoutes.some(r=>r.prefix===ex.prefix)){findings.push(tag+'prefix is not one of gatewayRoutes');continue;}
    if(!SERVICES.includes(ex.routesTo)){findings.push(tag+'routesTo is not a service ('+SERVICES.join(', ')+')');continue;}
    if(seen.has(ex.place+' '+ex.prefix)){findings.push(tag+'duplicate exception');continue;}
    seen.add(ex.place+' '+ex.prefix);
    findings.push(...untilFindings(tag,ex.until,today));
    const hits=analysis.diffs[ex.place].filter(d=>(d.probe===ex.prefix||d.probe.startsWith(ex.prefix+'/'))&&d.actual===ex.routesTo);
    if(!hits.length)findings.push(tag+'stale, the place no longer sends it to '+ex.routesTo+' (remove the exception)');
    for(const d of hits)covered.add(ex.place+' '+d.probe);
  }
  return {findings,covered};
}
export function ignoreFindings(io,today){
  const findings=[],swept=new Set(io.sweep()),seen=new Set();
  for(const e of io.ignore){
    const tag='sweep ignore '+e.file+': ';
    if(seen.has(e.file)){findings.push(tag+'listed twice');continue;}
    seen.add(e.file);
    if(typeof e.reason!=='string'||e.reason.trim().length<10)findings.push(tag+'no reason');
    if(e.until!==undefined)findings.push(...untilFindings(tag,e.until,today));
    const text=swept.has(e.file)?io.read(e.file):'';
    if(!PROXY.test(text))findings.push(tag+'stale, the file holds no proxy (remove the entry)');
    else if(e.only!==undefined){
      const hits=text.match(PROXY_ALL)??[];
      if(hits.length!==1||hits[0]!==e.only)findings.push(tag+'expected exactly one proxy, '+e.only+' (found '+hits.length+': '+hits.slice(0,3).join(' | ')+')');
    }
  }
  return findings;
}
export function openapiFindings(contracts,analysis,io){
  const findings=[],specs={clinic:JSON.parse(io.read(SERVICE_SPECS.clinic)),notification:JSON.parse(io.read(SERVICE_SPECS.notification))};
  const norm=path=>path.replace(/\{[^}]*\}/g,'{}');
  const entries=Object.fromEntries(Object.entries(specs).map(([service,spec])=>[service,new Map(Object.entries(spec.paths).map(([path,item])=>[norm(path),METHODS.filter(m=>m in item).join(',')]))]));
  for(const {path,methods} of analysis.paths){
    const owner=contracts.routeOwner(placeholders(path)),key=norm(path);
    if(owner==='core'){
      for(const [service,map] of Object.entries(entries))if(map.has(key))findings.push('openapi (a) '+path+' belongs to core but the '+service+' spec lists it');
    }else if(!entries[owner].has(key))findings.push('openapi (a) '+path+' belongs to '+owner+' but its spec does not list it');
    else if(entries[owner].get(key)!==methods.join(','))findings.push('openapi (a) '+path+' methods differ: gateway '+methods.join(',')+', '+owner+' '+entries[owner].get(key));
  }
  const gateway=new Set(analysis.paths.map(({path})=>norm(path)));
  for(const [service,spec] of Object.entries(specs))
    for(const path of Object.keys(spec.paths)){
      if(!path.startsWith('/api/')){
        if(!/^\/(?:internal\/.+|health|metrics)$/.test(path))findings.push('openapi (e) '+path+' in the '+service+' spec is not under /api/ or /internal/ and is not /health or /metrics');
        continue;
      }
      if(contracts.routeOwner(placeholders(path))!==service)findings.push('openapi (b) '+path+' is in the '+service+' spec but belongs to '+contracts.routeOwner(placeholders(path)));
      if(!gateway.has(norm(path)))findings.push('openapi (d) '+path+' is in the '+service+' spec but the gateway spec ('+GATEWAY_SPEC+') does not list it');
    }
  for(const {prefix,service} of contracts.gatewayRoutes){
    if(!analysis.paths.some(({path})=>(path===prefix||path.startsWith(prefix+'/'))&&contracts.routeOwner(placeholders(path))===service))findings.push('openapi (c) prefix '+prefix+' covers no path of the gateway spec');
    for(const other of contracts.gatewayRoutes)if(other.prefix!==prefix&&other.prefix.startsWith(prefix))findings.push('openapi (c) prefix '+prefix+' is a prefix of '+other.prefix);
  }
  return findings;
}
// The routers the monolith keeps behind requireAuth in mountCoreRoutes, where they are guarded: `block` is inside `if (clinical) {…}`,
// `inline` follows `if (monolith && clinical)`. Core serves them itself; every other literal of an owned prefix is a second source.
const LEGACY_MOUNTS={'/api/appointments':'block','/api/medical-records':'block','/api/notifications':'inline'};
export function literalFindings(contracts,io){
  const findings=[],routes=joinStrings(stripJsComments(io.read(CORE_ROUTES))),app=joinStrings(stripJsComments(io.read(CORE_APP)));
  const mount=prefix=>'app\\.use\\(\\s*([\'"])'+escapeRe(prefix)+'\\1\\s*,\\s*requireAuth\\b';
  const body=functionBody(routes,'mountCoreRoutes'),masked=[];
  if(!body)findings.push('literal '+CORE_ROUTES+': mountCoreRoutes was not found');
  else for(const {prefix} of contracts.gatewayRoutes){
    const kind=LEGACY_MOUNTS[prefix];
    if(!kind)continue;
    const found=[];
    if(kind==='block'){
      for(const guard of body.text.matchAll(/\bif\s*\(\s*clinical\s*\)\s*\{/g)){
        const open=body.start+guard.index+guard[0].length-1,close=jsBraceEnd(routes,open+1);
        for(const m of routes.slice(open,close).matchAll(new RegExp(mount(prefix),'g')))found.push(open+m.index);
      }
    }else for(const m of body.text.matchAll(new RegExp('\\bif\\s*\\(\\s*monolith\\s*&&\\s*clinical\\s*\\)\\s*'+mount(prefix),'g')))found.push(body.start+m.index);
    if(found.length!==1)findings.push('literal '+CORE_ROUTES+': expected one legacy mount of '+prefix+' behind '+(kind==='block'?'if (clinical) {…}':'if (monolith && clinical)')+' in mountCoreRoutes (found '+found.length+')');
    for(const at of found){const start=routes.indexOf(prefix,at);masked.push([start,start+prefix.length]);}
  }
  let scanned=routes;
  for(const [from,to] of masked)scanned=scanned.slice(0,from)+' '.repeat(to-from)+scanned.slice(to);
  for(const [file,code] of [[CORE_ROUTES,scanned],[CORE_APP,app]])for(const {prefix} of contracts.gatewayRoutes)if(prefixRe(prefix).test(code))findings.push('literal '+file+' names '+prefix+(file===CORE_ROUTES?' outside the legacy mounts':'')+'; take it from servicePrefixes()');
  if(!/from\s+'@nipopeto\/contracts'/.test(routes)||!/\bservicePrefixes\s*\(/.test(routes))findings.push('literal '+CORE_ROUTES+' does not take its prefixes from @nipopeto/contracts (servicePrefixes)');
  return findings;
}
export function distFindings(contracts,io){
  const src=[...io.read(ROUTES_SOURCE).matchAll(/\{\s*prefix:\s*'([^']+)',\s*service:\s*'([^']+)'\s*\}/g)].map(m=>m[1]+' '+m[2]);
  const dist=contracts.gatewayRoutes.map(r=>r.prefix+' '+r.service);
  if(!src.length)return ['dist could not read the routes of '+ROUTES_SOURCE];
  return JSON.stringify(src)===JSON.stringify(dist)?[]:['dist is out of date with '+ROUTES_SOURCE+': rebuild contracts (npm run build -w @nipopeto/contracts)'];
}
export function routingFindings(contracts,today,io,{dist=true}={}){
  const analysis=analyze(contracts,io),findings=[...analysis.errors];
  if(dist)findings.push(...distFindings(contracts,io));
  const {findings:exceptions,covered}=exceptionFindings(analysis,io,today,contracts);
  findings.push(...exceptions,...ignoreFindings(io,today));
  for(const place of io.places){
    const uncovered=analysis.diffs[place.id].filter(d=>!covered.has(place.id+' '+d.probe));
    if(uncovered.length&&!analysis.errors.some(e=>e.startsWith('fail-closed '+place.id+':')))
      findings.push('table '+place.id+' ('+place.topology+'): '+uncovered.length+' probes route differently, e.g. '+uncovered.slice(0,4).map(d=>d.probe+' -> '+d.actual+' (expected '+d.expected+')').join(', '));
  }
  for(const file of analysis.unlisted)findings.push('sweep '+file+' routes traffic (a proxy) but is not in ROUTING_PLACES');
  findings.push(...openapiFindings(contracts,analysis,io),...literalFindings(contracts,io));
  return findings;
}
// For S6: unchecked places (an unlisted proxy, or a place that could not be read), distinct routing tables, exceptions.
export function routingMetrics(contracts,io){
  const analysis=analyze(contracts,io);
  return {uncheckedPlaces:analysis.unlisted.length+analysis.errors.length,variants:analysis.variants,exceptions:io.exceptions.length,detail:{places:io.places.map(p=>p.id),unlisted:analysis.unlisted,unreadable:analysis.errors,exceptions:io.exceptions.map(e=>e.place+' '+e.prefix+' -> '+e.routesTo+' until '+e.until)}};
}
export const exceptionDays=(today,io)=>io.exceptions.map(e=>e.place+' '+e.prefix+': '+daysLeft(today,e.until)+' days left');
