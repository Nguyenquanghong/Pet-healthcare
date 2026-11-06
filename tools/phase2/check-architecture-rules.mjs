// Architecture fitness functions not covered by check-boundaries.mjs (inter-service
// imports/SQL/clients) or backend/scripts/check-architecture.mjs (Core layering):
//  1. Service layering (SERVICE_LAYERS, Clinic): each layer of src imports only the layers its row allows
//     (domain and application never reach Express, Prisma, the generated client, amqplib, infrastructure or http;
//     infrastructure never reaches http; http never reaches a storage or messaging client); a directory the table
//     does not name (lib/) and a root file that is not an entry fail.
//  2. Event contracts: every declared eventType is `<domain>.<name>.vN`, has a queue
//     binding; producers only emit declared types; parseEnvelope rejects other
//     schema versions and undeclared types (run against the built contracts).
//  3. Gateways never expose /internal, /metrics or /health to clients.
//  4. P7 least-privilege runtime grants cover every Prisma model, or the model is
//     explicitly excluded with a reason (stale exclusions also fail).
//  5. AQ-05 permissions come from the matrix in @nipopeto/contracts: no role list
//     or staff-role comparison in Core/Clinic/Notification, no 403 decided by the
//     owner role without an ownership check, and no matrix entry left unchecked.
//  6. The gateway OpenAPI (backend) and Clinic's own OpenAPI describe every shared
//     schema identically, except listed differences with a reason (stale ones fail).
//  7. Every notification type Core/Clinic/Notification send has an inbox tab in
//     @nipopeto/contracts, every listed type is really sent, and the OpenAPI tab
//     enums (gateway and Notification service) equal the contract's tabs.
//  8. Booking lifecycle rules come from one table in @nipopeto/contracts (P01).
//  9. Clinic's deferred list reads (authorized after their query, `deferred: true` in the route registry)
//     are GET handlers that answer through authorizedRead, they are exactly the three of ADR-P12, and the
//     gate (one && condition, read without comments) only opens for GET on the exact path with a closed breaker
//     and fails closed; mountRoutes puts the PEP of each route before its handler.
// 10. No two .ts files in services/*/src or backend/src/{composition,gateway,workers,routes/internal} are identical: a copy
//     belongs in packages/runtime or packages/messaging.
// 11. Service calls are declared (K5, replaces clinic-core-calls-confined): every synchronous HTTP call between Core, Clinic and Notification
//     (nine: the two Core proxies, three Core to Clinic billing calls, Clinic to Core directory, evidence and export, Notification to Core
//     authorize-send) is in deploy/phase2/service-calls.json, and tools/phase2/service-calls.mjs reads the code against it: every file of the
//     three services that makes an outbound HTTP call is declared (a call or an external system with a reason, S3 and VNPay), and every declared
//     file still makes one; the literals '/internal...' of a caller are its declared matches and no other file names /internal; each path is a
//     route of its receiver for the method and is in packages/contracts/internal/openapi.json, and a route with no caller is listed as
//     uncalled with a reason; the declared timeout, token (scoped, one per receiver) and forwarded headers are those of the code; a nested call
//     is shorter than the call around it or has a dated exception (UTC, at most 60 days ahead, stale ones fail); the receiver applies its gate.
//     A declaration that cannot be read fails; nothing passes silently. The metric S13 (arch-metrics.mjs, same code) counts the directions
//     with no declared call or with a call this rule faults, and the call sites it does not list; the ratchet holds both at 0.
// 12. Structure ratchet: the measured structure metrics (tools/phase2/arch-metrics.mjs) never get
//     worse than tools/phase2/arch-baseline.json; an improvement passes and asks to lower the baseline.
// 13. Shared packages (contracts excepted) name no service route: no literal path under /api/, /auth/ or /public/.
// 14. Every createRuntime call site in the services names limitRules (an empty list is an explicit choice).
// 15. Clinic's routes are declared only as elements of the registry (http/routes), each naming its resource: no
//     router.get/post/patch/put/delete/all in http/routes, http/scope.ts or app.ts.
// 16. Core module map (K3, K4): every backend/src file belongs to one group of tools/phase2/core-modules.json; an import between
//     two groups, and a table one group reads that another owns, must be declared there (and a declaration nothing uses fails);
//     the group `legacy` (backend/src/legacy) is imported by platform alone and reads the clinical tables alone, declared or not.
//     A table counts as read when a query reaches it through a relation nested in include, select, where, orderBy or _count (K4 Q6).
// 17. Legacy isolation (K4): outside backend/src/legacy, nothing imports legacy/ (composition/ excepted) and nothing reads a clinical
//     table: no delegate, raw SQL table, relation key (generated from the Prisma schema) or Prisma type of Appointment, MedicalRecord,
//     MedicalImage or Notification. A self-check fails the rule if its reader stops seeing the reads inside legacy/.
// 18. Gateway routes from one source (K5): every place that routes /api traffic (tools/phase2/gateway-routing.mjs ROUTING_PLACES) sends
//     the probe paths where packages/contracts/src/gatewayRoutes.ts says (core-ingress or direct), except listed exceptions (a prefix of
//     gatewayRoutes, a reason, a day at most 60 ahead; checked on their last day UTC); the places are the nginx configs (read like nginx
//     reads them, one server per port, only listed directives, anything it cannot follow fails; stack.mjs holds two templates, one per topology,
//     so nine places in all), the E2E proxy, the frontend client and the Vite dev proxy;
//     no proxy (proxy_pass, a Vite or Node proxy, a fetch of the request URL) in a file that is neither a place nor on the dated ignore
//     list, phase2-plan/evidence excepted; the gateway and service OpenAPI files list the same paths and agree on the owner of each;
//     Core's routes take their prefixes from the contracts, and only the three legacy mounts of mountCoreRoutes name one.
// Each rule also runs a negative fixture so a broken rule fails loudly.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,sep,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realIo,fixtureIo,routingFindings,analyze,nginxRoute,nginxLocations,locationName,listenPort,nginxTokens,stripJsComments,callArguments,fetchCalls,fetchUses,sweepFiles,exceptionDays} from './gateway-routing.mjs';
import {callsIo,fixtureCallsIo,serviceCallFindings,serviceCallMetrics,callExceptionDays,unconfinedHttpCalls,routesIn,DECLARATION} from './service-calls.mjs';

const root=resolve(import.meta.dirname,'../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='generated'?[]:e.isDirectory()?files(resolve(dir,e.name)):[resolve(dir,e.name)]);
// A rule that reads code must not be satisfied by text a comment holds: every pattern runs on the source without comments.
const withoutComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const results=[];
const rule=(name,fn)=>{try{const detail=fn();results.push({rule:name,status:'PASS',detail});}catch(error){results.push({rule:name,status:'FAIL',detail:error.message});}};

// ---- 1. Service layering -------------------------------------------------------
// A service's src is layered: domain <- application <- infrastructure, the http layer above them, and the entry files in the
// root, which compose everything. The table names, per layer, the layers it may import and the packages it may not; a directory
// the table does not name (lib/) and a root file that is not an entry fail, so a new place for code is a decision made here.
const clinicSrc=resolve(root,'services/clinic/src');
const FORBIDDEN=/^(express|@prisma\/client|amqplib|ioredis|redis|pg)$|generated\//;
export const SERVICE_LAYERS={
  clinic:{
    entries:['index.ts','worker.ts','runtime.ts','app.ts'],
    allowed:{
      domain:['domain'],
      application:['domain','application'],
      infrastructure:['domain','application','infrastructure','generated'],
      http:['domain','application','http','infrastructure'],
      '(root)':['domain','application','infrastructure','http','generated','(root)'],
    },
    // http answers requests through the use cases: express is its own, a storage or messaging client is not.
    forbidden:{domain:FORBIDDEN,application:FORBIDDEN,http:/^(@prisma\/client|amqplib|ioredis|redis|pg)$|generated\//},
  },
};
export function layerViolations(file,source,src=clinicSrc,{entries,allowed,forbidden}=SERVICE_LAYERS.clinic){
  const layerOf=path=>{const parts=relative(src,path).split(sep);return parts.length>1?parts[0]:'(root)';};
  const layer=layerOf(file),found=[];
  if(!(layer in allowed))return [layer+'/ is not a layer of this service'];
  if(layer==='(root)'&&!entries.includes(relative(src,file)))found.push(relative(src,file)+' is in the src root but is not an entry file');
  for(const m of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])([^'"]+)\1/g)){
    const spec=m[2];
    if(forbidden[layer]?.test(spec)){found.push(spec);continue;}
    if(spec.startsWith('.')){const target=layerOf(resolve(dirname(file),spec));if(!allowed[layer].includes(target))found.push(spec+' ('+layer+' may not import '+target+')');}
  }
  return found;
}
rule('service-layering',()=>{
  const scanned=files(clinicSrc).filter(f=>f.endsWith('.ts')),{entries}=SERVICE_LAYERS.clinic;
  const bad=scanned.flatMap(f=>layerViolations(f,readFileSync(f,'utf8')).map(s=>relative(root,f)+' -> '+s));
  assert.deepEqual(bad,[],'layer violations: '+bad.join(', '));
  const gone=entries.filter(e=>!scanned.some(f=>relative(clinicSrc,f)===e));
  assert.deepEqual(gone,[],'entry files that no longer exist (remove them from SERVICE_LAYERS): '+gone.join(', '));
  // negative fixtures
  const at=(file,source)=>layerViolations(resolve(clinicSrc,file),source);
  assert.ok(layerViolations(resolve(clinicSrc,'application/x.ts'),"import type { X } from '../directory.js'").length);
  assert.ok(layerViolations(resolve(clinicSrc,'application/x.ts'),"import { PrismaClient } from '../generated/client/index.js'").length);
  assert.ok(layerViolations(resolve(clinicSrc,'application/x.ts'),"import express from 'express'").length);
  assert.ok(layerViolations(resolve(clinicSrc,'domain/x.ts'),"import { a } from '../application/ports/a.js'").length);
  assert.equal(layerViolations(resolve(clinicSrc,'application/x.ts'),"import { a } from '../domain/a.js'").length,0);
  assert.equal(at('infrastructure/x.ts',"import { a } from '../http/a.js'").length,1,'infrastructure does not import http');
  assert.equal(at('http/x.ts',"import { PrismaClient } from '../generated/client/index.js'").length,1,'http does not import the generated client');
  assert.equal(at('http/x.ts',"import { PrismaClient } from '@prisma/client'").length,1,'http does not import a storage client');
  assert.equal(at('http/x.ts',"import { connect } from 'amqplib'").length,1,'http does not import a messaging client');
  assert.equal(at('http/x.ts',"import { a } from '../app.js'").length,1,'http does not import the root');
  assert.equal(at('application/x.ts',"import { a } from '../infrastructure/a.js'").length,1,'application does not import infrastructure');
  assert.equal(at('domain/x.ts',"import { a } from '../http/a.js'").length,1,'domain does not import http');
  assert.deepEqual(at('lib/x.ts','export const a = 1;'),['lib/ is not a layer of this service'],'a directory that is not a layer');
  assert.equal(at('stray.ts','export const a = 1;').length,1,'a root file that is not an entry');
  assert.equal(at('stray.ts',"import { a } from './domain/a.js'").length,1,'a root file that is not an entry, whatever it imports');
  assert.deepEqual(at('http/x.ts',"import express from 'express'; import { a } from '../infrastructure/a.js'; import { b } from './b.js'; import { c } from '../domain/c.js';"),[],'http: express, infrastructure, its own layer, domain');
  assert.deepEqual(at('infrastructure/x.ts',"import { P } from '../generated/client/index.js'; import { a } from '../application/a.js'; import { b } from './core/b.js'; import pg from 'pg';"),[],'infrastructure: the generated client, application, itself, a storage client');
  assert.deepEqual(at('app.ts',"import { a } from './http/a.js'; import { b } from './infrastructure/b.js'; import { P } from './generated/client/index.js'; import { c } from './runtime.js';"),[],'an entry imports every layer');
  assert.deepEqual(at('index.ts',"import { createApp } from './app.js';"),[],'an entry imports an entry');
  return scanned.length+' files, '+entries.length+' entries';
});

// ---- 2. Event contracts --------------------------------------------------------
// AMQP topic semantics: '*' = exactly one word, '#' = zero or more words.
export function topicMatches(pattern,key){
  const match=(p,k)=>!p.length?!k.length:p[0]==='#'?match(p.slice(1),k)||(k.length>0&&match(p,k.slice(1))):k.length>0&&(p[0]==='*'||p[0]===k[0])&&match(p.slice(1),k.slice(1));
  return match(pattern.split('.'),key.split('.'));
}
export function bindings(messagingSource){return [...messagingSource.matchAll(/\bbindQueue\(t\.(\w+),\s*t\.exchange,\s*'([^']+)'\)/g)].map(m=>({queue:m[1],key:m[2]}));}
export function declaredTypes(contractsSource){const m=contractsSource.match(/export const eventTypes\s*=\s*\[([^\]]+)\]/);return m?[...m[1].matchAll(/'([^']+)'/g)].map(x=>x[1]):[];}
export function emittedTypes(source,families){return [...source.matchAll(/['"`]([a-z]+\.[a-z]+(?:-[a-z]+)*\.v\d+)['"`]/g)].map(m=>m[1]).filter(t=>families.has(t.split('.')[0]));}
const contractsSource=read('packages/contracts/src/index.ts'),types=declaredTypes(contractsSource),families=new Set(types.map(t=>t.split('.')[0]));
rule('event-types-declared-and-bound',()=>{
  assert.ok(types.length>0,'no eventTypes found');
  const bound=bindings(read('packages/messaging/src/topology.ts'));
  for(const t of types){
    assert.match(t,/^[a-z]+\.[a-z]+(?:-[a-z]+)*\.v\d+$/,'bad event type name '+t);
    assert.ok(bound.some(b=>topicMatches(b.key,t)),'no queue binding for '+t);
  }
  assert.ok(topicMatches('directory.#','directory.owner-upserted.v1')&&topicMatches('directory.#','directory')&&!topicMatches('directory.#','billing.x.v1'));
  assert.ok(topicMatches('a.*.v1','a.b.v1')&&!topicMatches('a.*.v1','a.b.c.v1')&&topicMatches('#','x.y')&&!topicMatches('a.b','a.b.c'));
  return types.length+' types, '+bound.length+' bindings';
});
rule('producers-emit-declared-types',()=>{
  const producers=['backend/src','services/clinic/src','services/notification/src'].flatMap(d=>files(resolve(root,d))).filter(f=>f.endsWith('.ts'));
  const undeclared=producers.flatMap(f=>emittedTypes(readFileSync(f,'utf8'),families).filter(t=>!types.includes(t)).map(t=>relative(root,f)+': '+t));
  assert.deepEqual(undeclared,[],'undeclared: '+undeclared.join(', '));
  assert.deepEqual(emittedTypes("routingKey='billing.invoice-voided.v1'",families),['billing.invoice-voided.v1']);
  assert.deepEqual(emittedTypes("prefix='nipopeto.local.v1'",families),[]);
  return producers.length+' files';
});
const built=resolve(root,'packages/contracts/dist/index.js');
const envelopeCheck=existsSync(built)?import(pathToFileURL(built).href).then(({parseEnvelope})=>{
  rule('envelope-version-enforced',()=>{
    const base={eventId:'e',eventType:'billing.operation-aborted.v1',schemaVersion:1,producer:'core',aggregateType:'op',aggregateId:'o',aggregateVersion:1,occurredAt:new Date().toISOString(),correlationId:'c',payload:{operationId:'o'}};
    assert.equal(parseEnvelope(JSON.stringify(base)).schemaVersion,1);
    assert.throws(()=>parseEnvelope(JSON.stringify({...base,schemaVersion:2})));
    assert.throws(()=>parseEnvelope(JSON.stringify({...base,eventType:'billing.operation-unknown.v1'})));
    assert.throws(()=>parseEnvelope(JSON.stringify({...base,producer:'notification'})));
    return 'v1 accepted; v2/undeclared/foreign producer rejected';
  });
}):Promise.resolve(rule('envelope-version-enforced',()=>{throw new Error('build packages/contracts first (npm run build -w @nipopeto/contracts)');}));

// ---- 3. Gateways ---------------------------------------------------------------
const GATEWAYS=['deploy/phase2/nginx.split.conf.example','benchmarks/phase2/kaggle/stack.mjs','frontend/nginx/default.conf.template'];
export const blocksInternal=source=>/location\s+~\s+\^\/\(internal\|metrics\|health\)\s*\{\s*return\s+404;\s*\}/.test(source);
rule('gateway-hides-internal-routes',()=>{
  const missing=GATEWAYS.filter(g=>!blocksInternal(read(g)));
  assert.deepEqual(missing,[],'gateway without /internal|/metrics|/health block: '+missing.join(', '));
  assert.equal(blocksInternal('location /api/ { proxy_pass http://core; }'),false);
  return GATEWAYS.length+' gateway configs';
});
// P08 part A: the Core gateway forwards through serviceProxy (one Circuit Breaker
// per downstream), never a hand-written fetch in the composition root.
export const directFetches=source=>source.split(/\r?\n/).flatMap((line,index)=>/(^|[^\w.])fetch\s*\(/.test(line)?['line '+(index+1)]:[]);
rule('gateway-uses-service-proxy',()=>{
  const files=['backend/src/composition/coreApp.ts','backend/src/composition/coreRoutes.ts'],sources=files.map(read);
  for(const [index,file] of files.entries())assert.deepEqual(directFetches(sources[index]),[],file+' calls fetch directly; route it through serviceProxy');
  const source=sources.join('\n');
  assert.ok(/serviceProxy\(\{\s*name:\s*'clinic'/.test(source)&&/serviceProxy\(\{\s*name:\s*'notification'/.test(source),'both downstreams use serviceProxy');
  // negative fixtures
  assert.deepEqual(directFetches("app.use(x,async(req,res)=>{const r=await fetch(url,{method:req.method});})"),['line 1']);
  assert.deepEqual(directFetches("const r=await breaker.run(()=>send(target,req,url));\n// prefetch(1) and res.fetchLater are not fetch"),[]);
  return 'clinic and notification through serviceProxy';
});

// ---- 4. Runtime grants cover every model ---------------------------------------
// The P7 runtime role is least-privilege, so a model added after P7 without a
// grant only fails after cutover (AppointmentQueryEpoch was read by the aggregate
// cache but never granted). Every model is granted or explicitly excluded here.
const NOT_RUNTIME={
  core:{appointments:'Phase 1 table moved to Clinic (P7 revokes it)',medical_records:'moved to Clinic',medical_images:'moved to Clinic',notifications:'moved to Notification'},
  clinic:{ProofAppointment:'P1 proof model, not used by runtime services',BillingReservation:'P1 proof model, not used by runtime services'},
  notification:{},
};
export function ungranted(statements,tables,excluded){
  const sql=statements.join(' ');
  return tables.filter(t=>!sql.includes('."'+t+'"')&&!(t in excluded));
}
const grantsCheck=Promise.all([import(pathToFileURL(resolve(root,'tools/phase2/p7-cutover.mjs')).href),import(pathToFileURL(resolve(root,'tools/phase2/p7-manifest.mjs')).href)])
  .then(([cutover,manifest])=>rule('runtime-grants-cover-every-model',()=>{
    const bad=[],stale=[];
    for(const kind of ['core','clinic','notification']){
      const tables=Object.values(manifest.catalogs[kind]).map(d=>d.table),statements=cutover.runtimeGrantStatements(kind,'"r"',true,'runtime');
      bad.push(...ungranted(statements,tables,NOT_RUNTIME[kind]).map(t=>kind+'.'+t));
      stale.push(...Object.keys(NOT_RUNTIME[kind]).filter(t=>!tables.includes(t)).map(t=>kind+'.'+t));
    }
    assert.deepEqual(bad,[],'models without runtime grant or explicit exclusion: '+bad.join(', '));
    assert.deepEqual(stale,[],'exclusions for models that no longer exist: '+stale.join(', '));
    assert.deepEqual(ungranted(['GRANT SELECT ON runtime."a" TO r'],['a','b'],{}),['b']);
    return 'core/clinic/notification models granted or excluded with a reason';
  }),error=>rule('runtime-grants-cover-every-model',()=>{throw error;}));

// ---- 5. Permissions come from the matrix (AQ-05) -------------------------------
const SERVICE_SOURCES=['backend/src','services/clinic/src','services/notification/src'];
const AUTHORIZATION=new Set(['backend/src/domain/authorization.ts','services/clinic/src/domain/authorization.ts']);
const OWNER_ROLE=/\brole\s*[!=]==?\s*['"]owner['"]|['"]owner['"]\s*[!=]==?\s*[\w.?]*\brole\b/;
// Identity checks (token role equals stored role) and ownership scope are not permissions.
export function permissionViolations(source){
  const found=[];
  source.split(/\r?\n/).forEach((line,index)=>{
    const at='line '+(index+1)+': ';
    if(/\brequireRole\s*\(/.test(line))found.push(at+'requireRole');
    if(/\brole\s*[!=]==?\s*['"](admin|doctor|staff)['"]|['"](admin|doctor|staff)['"]\s*[!=]==?\s*[\w.?]*\brole\b/.test(line))found.push(at+'staff-role comparison');
    if(/\[\s*['"](owner|admin|doctor|staff)['"]\s*,[^\]]*\]\s*\.includes\([^)]*\brole\b/.test(line))found.push(at+'inline role list');
    if(/Error\(\s*403|status\(\s*403\s*\)/.test(line)&&OWNER_ROLE.test(line)&&!/\.sub\b|ownerId/.test(line))found.push(at+'403 decided by the owner role');
  });
  return found;
}
const checked=(source,permission)=>new RegExp(`\\b(authorize|requirePermission|allows|deniedMessage)\\([^)]*['"]${permission.replaceAll('.','\\.')}['"]`).test(source);
const permissionCheck=(existsSync(built)?import(pathToFileURL(built).href):Promise.reject(new Error('build packages/contracts first (npm run build -w @nipopeto/contracts)')))
  .then(({permissions,bookingLifecycles})=>rule('permissions-from-matrix',()=>{
    const scanned=SERVICE_SOURCES.flatMap(d=>files(resolve(root,d))).filter(f=>f.endsWith('.ts')&&!AUTHORIZATION.has(relative(root,f).split(sep).join('/')));
    const bad=scanned.flatMap(f=>permissionViolations(readFileSync(f,'utf8')).map(v=>relative(root,f)+' '+v));
    assert.deepEqual(bad,[],'role decisions outside the permission matrix: '+bad.join('; '));
    const all=scanned.map(f=>readFileSync(f,'utf8')).join('\n');
    // P01: lifecycle rules name their permission in the table; the services check it as rule.permission.
    const viaLifecycle=/\bauthorize\(actor,\s*rule\.permission\)/.test(all)?new Set(Object.values(bookingLifecycles).flatMap(l=>[...Object.values(l.manual).flat(),...Object.values(l.undo)]).map(r=>r.permission)):new Set();
    const unused=permissions.filter(p=>!checked(all,p)&&!viaLifecycle.has(p));
    assert.deepEqual(unused,[],'matrix permissions never checked: '+unused.join(', '));
    // negative fixtures
    for(const sample of ["if (actor.role === 'admin') x();","if(!['admin','staff'].includes(actor.role))throw e;","if (actor.role === 'owner') throw new BusinessError(403, 'x');","router.use(requireRole('admin'))","if(actor.role==='owner'){res.status(403);return;}"])
      assert.ok(permissionViolations(sample).length,'fixture not detected: '+sample);
    for(const sample of ["if (actor.role === 'owner' && pet.ownerId !== actor.sub) throw new BusinessError(403, 'x');","if(!sender||sender.role!==actor.role)res.status(403);","const own=actor.role==='owner'?{ownerId:actor.sub}:{};","authorize(actor, 'booking.manage');"])
      assert.deepEqual(permissionViolations(sample),[],'false positive: '+sample);
    assert.equal(checked("authorize(actor, 'booking.manage')",'booking.manage'),true);
    assert.equal(checked("authorize(actor, 'booking.manager')",'booking.manage'),false);
    return scanned.length+' files, '+permissions.length+' permissions checked';
  }),error=>rule('permissions-from-matrix',()=>{throw error;}));

// ---- 5b. Consumers name the events they apply (F7) ------------------------------
// Each consumer's list in contracts is bound to its queue, every declared type has a
// consumer, and every billing type Clinic consumes has an explicit outcome, so a new
// billing event cannot be read as an abort by default.
const clinicBilling=resolve(root,'services/clinic/dist/infrastructure/messaging/billingEvents.js');
const consumerQueues={notification:'notification',identity:'identity',clinic:'clinic'};
// P03: a draining type moved to another consumer's queue; the old queue no longer receives it.
export function consumerGaps({eventTypes,consumedEvents,drainingEvents={}},bound,outcomes){
  const gaps=[];
  for(const [consumer,list] of Object.entries(drainingEvents))for(const t of list){
    if(!Object.entries(consumedEvents).some(([other,types])=>other!==consumer&&types.includes(t)))gaps.push(consumer+' drains '+t+' that no other consumer took over');
    if(bound.some(b=>b.queue===consumerQueues[consumer]&&topicMatches(b.key,t)))gaps.push(consumer+' queue still bound to draining '+t);
  }
  for(const t of eventTypes)if(!Object.values(consumedEvents).some(list=>list.includes(t)))gaps.push('no consumer for '+t);
  for(const [consumer,list] of Object.entries(consumedEvents))for(const t of list){
    if(!eventTypes.includes(t))gaps.push(consumer+' consumes undeclared '+t);
    if(!bound.some(b=>b.queue===consumerQueues[consumer]&&topicMatches(b.key,t)))gaps.push(consumer+' queue not bound to '+t);
  }
  const billing=consumedEvents.clinic.filter(t=>t.startsWith('billing.'));
  for(const t of billing)if(!Object.hasOwn(outcomes,t))gaps.push('clinic has no billing outcome for '+t);
  for(const t of Object.keys(outcomes))if(!billing.includes(t))gaps.push('billing outcome for unconsumed '+t);
  return gaps;
}
const consumerCheck=(existsSync(built)&&existsSync(clinicBilling)?Promise.all([import(pathToFileURL(built).href),import(pathToFileURL(clinicBilling).href)]):Promise.reject(new Error('build packages/contracts and services/clinic first (npm run phase2:build)')))
  .then(([contracts,{billingOutcomes}])=>rule('event-consumers-explicit',()=>{
    const bound=bindings(read('packages/messaging/src/topology.ts'));
    assert.deepEqual(consumerGaps(contracts,bound,billingOutcomes),[]);
    // negative fixtures
    const voided={eventTypes:[...contracts.eventTypes,'billing.invoice-voided.v1'],consumedEvents:{...contracts.consumedEvents,clinic:[...contracts.consumedEvents.clinic,'billing.invoice-voided.v1']}};
    assert.deepEqual(consumerGaps(voided,bound,billingOutcomes),['clinic has no billing outcome for billing.invoice-voided.v1']);
    assert.ok(consumerGaps({...contracts,eventTypes:[...contracts.eventTypes,'audit.thing-happened.v1']},bound,billingOutcomes).includes('no consumer for audit.thing-happened.v1'));
    assert.ok(consumerGaps(contracts,bound.filter(b=>b.queue!=='notification'),billingOutcomes).some(g=>g.startsWith('notification queue not bound')));
    assert.deepEqual(consumerGaps(contracts,[...bound,{queue:'notification',key:'identity.sessions-revoked.v1'}],billingOutcomes),['notification queue still bound to draining identity.sessions-revoked.v1']);
    assert.deepEqual(consumerGaps({...contracts,drainingEvents:{...contracts.drainingEvents,clinic:['audit.thing-happened.v1']}},bound,billingOutcomes),['clinic drains audit.thing-happened.v1 that no other consumer took over']);
    assert.deepEqual(bindings("await channel.unbindQueue(t.notification, t.exchange, 'identity.sessions-revoked.v1');"),[],'an unbind is not a binding');
    return Object.keys(contracts.consumedEvents).length+' consumers, '+Object.keys(billingOutcomes).length+' billing outcomes';
  }),error=>rule('event-consumers-explicit',()=>{throw error;}));

// ---- 6. Shared OpenAPI schemas agree (AQ-07) -----------------------------------
// The frontend types are generated from the gateway spec; Clinic's spec is the
// service's own contract. A schema both declare must not drift apart silently.
const SPEC_DIFFERENCES={
  CreateInvoiceInput:'expectedRevision belongs to Core split billing (P4), Clinic never receives it',
  User:'permissions is only in Core session responses (AQ-05)',
};
const canonicalJson=value=>JSON.stringify(value,(key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function specDrift(gateway,clinic,allowed){
  const shared=Object.keys(gateway).filter(name=>name in clinic);
  return {drift:shared.filter(name=>!(name in allowed)&&canonicalJson(gateway[name])!==canonicalJson(clinic[name])),
    stale:Object.keys(allowed).filter(name=>!shared.includes(name)||canonicalJson(gateway[name])===canonicalJson(clinic[name]))};
}
rule('shared-openapi-schemas-agree',()=>{
  const gateway=JSON.parse(read('backend/openapi.json')).components.schemas,clinic=JSON.parse(read('services/clinic/openapi.json')).components.schemas;
  const {drift,stale}=specDrift(gateway,clinic,SPEC_DIFFERENCES);
  assert.deepEqual(drift,[],'schemas that differ between backend/openapi.json and services/clinic/openapi.json: '+drift.join(', '));
  assert.deepEqual(stale,[],'listed differences that no longer differ or no longer exist: '+stale.join(', '));
  // negative fixtures
  assert.deepEqual(specDrift({A:{type:'string'}},{A:{type:'integer'}},{}).drift,['A']);
  assert.deepEqual(specDrift({A:{type:'string',description:'x'}},{A:{description:'x',type:'string'}},{}).drift,[]);
  assert.deepEqual(specDrift({A:{type:'string'}},{A:{type:'string'}},{A:'reason'}).stale,['A']);
  return Object.keys(gateway).filter(n=>n in clinic).length+' shared schemas, '+Object.keys(SPEC_DIFFERENCES).length+' listed differences';
});

// ---- 7. Inbox tabs cover every sent notification type ---------------------------
// A sent notification is an object literal naming recipientRole and a literal type.
const SENT_TYPE=/\brecipientRole\b[^;{}]*?\btype\s*:\s*['"]([a-z][a-z_]*)['"]/g;
export const sentNotificationTypes=source=>[...source.matchAll(SENT_TYPE)].map(m=>m[1]);
const categoryCheck=(existsSync(built)?import(pathToFileURL(built).href):Promise.reject(new Error('build packages/contracts first (npm run build -w @nipopeto/contracts)')))
  .then(({notificationTypes,notificationCategoryNames})=>rule('notification-tabs-cover-sent-types',()=>{
    const sent=new Set(SERVICE_SOURCES.flatMap(d=>files(resolve(root,d))).filter(f=>f.endsWith('.ts')).flatMap(f=>sentNotificationTypes(readFileSync(f,'utf8'))));
    const untabbed=[...sent].filter(t=>!notificationTypes.includes(t)),unsent=notificationTypes.filter(t=>!sent.has(t));
    assert.deepEqual(untabbed,[],'sent notification types without an inbox tab in @nipopeto/contracts: '+untabbed.join(', '));
    assert.deepEqual(unsent,[],'tabbed notification types nothing sends: '+unsent.join(', '));
    const gateway=JSON.parse(read('backend/openapi.json')),service=JSON.parse(read('services/notification/openapi.json'));
    const param=(spec,path)=>spec.paths[path].get.parameters.find(p=>p.name==='category').schema;
    assert.deepEqual(gateway.components.schemas.NotificationCategory.enum,notificationCategoryNames,'backend/openapi.json NotificationCategory');
    assert.deepEqual(param(gateway,'/notifications').oneOf,[{type:'string',enum:['all']},{$ref:'#/components/schemas/NotificationCategory'}],'gateway category parameter');
    assert.deepEqual(param(service,'/api/notifications').enum,['all',...notificationCategoryNames],'services/notification/openapi.json category parameter');
    // negative fixtures
    assert.deepEqual(sentNotificationTypes("writeNotification(tx, { recipientOwnerId: o, recipientRole: 'owner', type: 'invoice_paid', title })"),['invoice_paid']);
    assert.deepEqual(sentNotificationTypes('notify({ recipientRole, type: "booking_status_updated" })'),['booking_status_updated']);
    assert.deepEqual(sentNotificationTypes("{ recipientRole: 'owner' }; const x = { type: 'general' };"),[]);
    assert.deepEqual(sentNotificationTypes("{ recipientRole: p.recipientRole ?? 'owner', type: p.type ?? 'general' }"),[]);
    return sent.size+' sent types, '+notificationCategoryNames.length+' tabs';
  }),error=>rule('notification-tabs-cover-sent-types',()=>{throw error;}));

// ---- 8. Booking lifecycle from one table (P01) ----------------------------------
// The transition rules live in @nipopeto/contracts. The services that enforce them
// hold no status lists of their own, every status has a label, and every SQL object
// that decides which bookings still hold a slot or a room names exactly the table's
// occupying set (or, for NOT IN, exactly the other statuses).
const LIFECYCLE_SERVICES=['backend/src/application/services/bookingLifecycle.ts','services/clinic/src/application/services/bookingLifecycle.ts'];
const OCCUPANCY_OBJECTS={appointment:['appointments_active_pet_slot_key','appointment_schedule_sync','appointment_schedule_rebuild'],hotel:['hotel_bookings_pet_active_stay_excl','hotel_room_nights_sync']};
const STATUS_LITERAL=/['"](pending|confirmed|checked_in|in_progress|completed|cancelled|no_show|in_stay|checked_out|rejected)['"]/;
// A status event's action name (transition, undo, cancelled...) is not a status.
export const statusLiterals=source=>source.split(/\r?\n/).flatMap((line,index)=>STATUS_LITERAL.test(line.replace(/\.event\(\s*actor\s*,\s*['"][a-z_]+['"]/g,''))?['line '+(index+1)]:[]);
// The SQL statement (or plpgsql function body) that defines a named object.
export function sqlBlocks(sql,name){
  const lines=sql.split(/\r?\n/),blocks=[];
  lines.forEach((line,index)=>{
    if(!line.includes(name)||line.trimStart().startsWith('--')||/EXECUTE FUNCTION/.test(line)&&!/CREATE (OR REPLACE )?FUNCTION/.test(line))return;
    const fn=/CREATE (OR REPLACE )?FUNCTION/i.test(line),end=lines.findIndex((l,i)=>i>=index&&(fn?/\$\$\s*;/.test(l):/;\s*$/.test(l)));
    blocks.push(lines.slice(index,end<0?lines.length:end+1).join('\n'));
  });
  return blocks;
}
export const statusPredicates=sql=>[...sql.replaceAll("''","'").matchAll(/"?status"?\s+(NOT\s+)?IN\s*\(([^)]*)\)/gi)].map(m=>({negated:Boolean(m[1]),set:[...m[2].matchAll(/'([a-z_]+)'/g)].map(x=>x[1]).sort()}));
export function occupancyDrift(predicates,{statuses,occupying}){
  const want=JSON.stringify([...occupying].sort()),rest=JSON.stringify(statuses.filter(s=>!occupying.includes(s)).sort());
  return predicates.filter(p=>JSON.stringify(p.set)!==(p.negated?rest:want));
}
const migrationSql=['backend/prisma/migrations','services/clinic/prisma/migrations'].flatMap(d=>files(resolve(root,d))).filter(f=>f.endsWith('migration.sql')).map(f=>({file:relative(root,f),sql:readFileSync(f,'utf8')}));
const lifecycleCheck=(existsSync(built)?import(pathToFileURL(built).href):Promise.reject(new Error('build packages/contracts first (npm run build -w @nipopeto/contracts)')))
  .then(({bookingLifecycles,bookingStatusLabels})=>rule('lifecycle-from-table',()=>{
    const written=LIFECYCLE_SERVICES.flatMap(f=>statusLiterals(read(f)).map(v=>f+' '+v));
    assert.deepEqual(written,[],'status literals in lifecycle services (use the table in @nipopeto/contracts): '+written.join('; '));
    const unlabelled=Object.values(bookingLifecycles).flatMap(l=>l.statuses).filter(s=>!Object.hasOwn(bookingStatusLabels,s));
    assert.deepEqual(unlabelled,[],'statuses without a label');
    let checked=0;const drift=[];
    for(const [kind,names] of Object.entries(OCCUPANCY_OBJECTS))for(const name of names)for(const {file,sql} of migrationSql)for(const block of sqlBlocks(sql,name)){
      const predicates=statusPredicates(block);checked+=predicates.length;
      for(const p of occupancyDrift(predicates,bookingLifecycles[kind]))drift.push(`${file} ${name}: ${p.negated?'NOT IN':'IN'} (${p.set.join(',')})`);
    }
    assert.deepEqual(drift,[],'SQL occupying sets differ from the lifecycle table');
    assert.ok(checked>=5,'found the occupying predicates ('+checked+')');
    // negative fixtures
    assert.deepEqual(statusLiterals("const transitions={pending:['confirmed','cancelled']};"),['line 1']);
    assert.deepEqual(statusLiterals('const rule = manualTransition(kind, from, to);'),[]);
    assert.deepEqual(statusLiterals('await tx.event(actor, "cancelled", from, rule.to, 1);'),[]);
    assert.deepEqual(statusLiterals('await tx.save("cancelled");'),['line 1']);
    const appointment=bookingLifecycles.appointment,hotel=bookingLifecycles.hotel;
    assert.equal(occupancyDrift(statusPredicates("CREATE UNIQUE INDEX x ON appointments(pet_id) WHERE status NOT IN ('cancelled');"),appointment).length,1);
    assert.equal(occupancyDrift(statusPredicates("EXECUTE 'CREATE INDEX x WHERE \"status\" NOT IN (''cancelled'', ''no_show'')';"),appointment).length,0);
    assert.equal(occupancyDrift(statusPredicates("WHERE (\"status\" IN ('pending', 'confirmed'))"),hotel).length,1);
    assert.equal(sqlBlocks("CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  x := NEW.status IN ('pending');\nEND $$;\nSELECT 1 WHERE status IN ('a');",'f').map(statusPredicates).flat().length,1);
    return LIFECYCLE_SERVICES.length+' services, '+checked+' SQL predicates';
  }),error=>rule('lifecycle-from-table',()=>{throw error;}));

// ---- 9. Deferred list reads answer through authorizedRead (B) -------------------
// A route declared `deferred: true` in Clinic's registry is authorized by Core only after its query ran. That is safe
// because authorizedRead settles (and lets a Core refusal win) before it answers, so every deferred route must be a GET
// whose own handler uses it, the deferred routes must be exactly the three of ADR-P12, and the gate that skips the
// up-front authorize must require GET, the exact path and a closed breaker, and fail closed.
export const DEFERRED_PATHS=['/appointments','/medical-records','/medical-records/images'];
// The gate is the policy enforcement point of http/scope.ts: it reads the declaration of the route it guards, so the
// paths that defer are the routes that say `deferred: true`, compared with the three of ADR-P12 below.
// The gate is ONE `if` whose condition joins its four terms with && and nothing else (an || between them, or the breaker
// computed into a variable and left out of the condition, opens the gate to more than a GET on the exact path with a closed
// breaker), and the body of that `if` fails closed. mountRoutes puts the PEP of each route before its handler. Comments are
// not code: both sources are read without them, so a term that only a comment holds is not there.
const DEFERRED_TERMS=[
  [/req\.method\s*===\s*'GET'\s*&&\s*route\.deferred\b/,'the deferred gate does not require GET'],
  [/req\.path\s*===\s*route\.path\b/,'the deferred gate does not match the exact path'],
  [/breaker\?\.state\s*===\s*'closed'/,'the deferred gate does not require a closed breaker'],
];
const DEFERRED_GATE=/\bif\s*\(\s*req\.method\s*===\s*'GET'\s*&&\s*route\.deferred\s*&&\s*req\.path\s*===\s*route\.path\s*&&\s*[\w$.!]*breaker\?\.state\s*===\s*'closed'\s*\)\s*\{/;
const DEFERRED_SHAPE='the deferred gate is not one condition joining GET, route.deferred, the exact path and a closed breaker with &&';
const FAIL_CLOSED=[/\bfailClosed\(/,'the deferred gate does not fail closed'];
const MOUNT_WITH_PEP=/\brouter\[route\.method\]\(\s*route\.path\s*,\s*pep\(route\s*,[^()]*\)\s*,\s*route\.handler\s*\)/;
const MOUNT_MESSAGE='mountRoutes does not put the pep of each route before its handler';
// The text between the braces of the block whose `{` is at `open`; to the end of the source if it never closes.
const blockAt=(source,open)=>{let depth=0;for(let i=open;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return source.slice(open+1,i);}return source.slice(open+1);};
// A route element is `{ method: 'get', path: '/x', ...` up to the next element (or the end of the array): its handler is in it.
export function deferredRouteViolations(routeSource,gateSource){
  const gate=withoutComments(gateSource),found=[],elements=withoutComments(routeSource).split(/\{\s*method:\s*'/).slice(1).map(text=>{
    const part=text.split(/\r?\n\s*\];/)[0],head=part.match(/^(\w+)',\s*path:\s*'([^']+)'/);
    return {method:head?.[1],path:head?.[2],deferred:/\bdeferred:\s*true\b/.test(part),part};
  });
  if(!elements.length)found.push('no route elements found');
  const deferred=elements.filter(e=>e.deferred);
  for(const e of deferred){
    const name=(e.method??'?').toUpperCase()+' '+(e.path??'?');
    if(e.method!=='get')found.push(name+': deferred is only for GET');
    else if(!/\bauthorizedRead\(/.test(e.part))found.push(name+': GET handler does not use authorizedRead');
  }
  const paths=deferred.map(e=>e.path),missing=DEFERRED_PATHS.filter(p=>!paths.includes(p)),extra=paths.filter(p=>!DEFERRED_PATHS.includes(p));
  if(missing.length)found.push('deferred route missing: '+missing.join(', '));
  if(extra.length)found.push('deferred route not in ADR-P12: '+extra.join(', '));
  const missed=DEFERRED_TERMS.filter(([pattern])=>!pattern.test(gate)).map(([,message])=>message),open=DEFERRED_GATE.exec(gate);
  found.push(...missed);
  if(!open&&!missed.length)found.push(DEFERRED_SHAPE);
  if(!FAIL_CLOSED[0].test(open?blockAt(gate,open.index+open[0].length-1):gate))found.push(FAIL_CLOSED[1]);
  if(!MOUNT_WITH_PEP.test(gate))found.push(MOUNT_MESSAGE);
  return found;
}
rule('deferred-reads-via-authorized-read',()=>{
  const routeDir='services/clinic/src/http/routes',routeFiles=readdirSync(resolve(root,routeDir)).filter(f=>f.endsWith('.ts')).sort();
  const routeSource=routeFiles.map(f=>read(routeDir+'/'+f)).join('\n'),gateSource=read('services/clinic/src/http/scope.ts'),bad=deferredRouteViolations(routeSource,gateSource);
  assert.deepEqual(bad,[],'deferred list reads that break the contract: '+bad.join('; '));
  // negative fixtures: one reason each
  const via='authorizedRead(res, () => list())',get=(path,deferred,handler)=>`  { method: 'get', path: '${path}', resource: 'none',${deferred?' deferred: true,':''} handler: async (req, res) => ${handler} },\n`;
  const routesOf=(...entries)=>`export const routes = (u) => [\n${entries.join('')}];\n`;
  const three=DEFERRED_PATHS.map(p=>get(p,true,via)),next=get('/dashboard/clinic',false,'res.json(1)'),goodRoutes=routesOf(...three,next);
  const gateIf="if (req.method === 'GET' && route.deferred && req.path === route.path && source.breaker?.state === 'closed') { failClosed(res, d); next(); }";
  const mount='export function mountRoutes(router, routes, deps) { for (const route of routes) router[route.method](route.path, pep(route, deps), route.handler); }';
  const goodGate=gateIf+'\n'+mount;
  const reasons=(routes,gate=goodGate)=>deferredRouteViolations(routes,gate);
  assert.deepEqual(reasons(goodRoutes),[]);
  assert.deepEqual(reasons(routesOf(get('/appointments',true,'res.json(await list())'),...three.slice(1),next)),['GET /appointments: GET handler does not use authorizedRead']);
  assert.deepEqual(reasons(routesOf(...three.slice(0,2),get('/medical-records/images',true,'res.json(1)'),get('/dashboard/clinic',false,via))),['GET /medical-records/images: GET handler does not use authorizedRead'],'authorizedRead on the next route does not count');
  assert.deepEqual(reasons(routesOf(...three.slice(0,2),get('/medical-records/images',true,'res.json(1)'))+'const helper = () => authorizedRead(res, () => list());\n'),['GET /medical-records/images: GET handler does not use authorizedRead'],'authorizedRead after the array does not count');
  assert.deepEqual(reasons(routesOf(...three,`  { method: 'post', path: '/appointments/x', resource: 'none', deferred: true, handler: async (req, res) => ${via} },\n`)).slice(0,1),['POST /appointments/x: deferred is only for GET']);
  assert.deepEqual(reasons(routesOf(...three,get('/dashboard/clinic',true,via))).slice(0,1),['deferred route not in ADR-P12: /dashboard/clinic']);
  assert.deepEqual(reasons(routesOf(...three.slice(0,2),get('/medical-records/images',false,via),next)).slice(0,1),['deferred route missing: /medical-records/images']);
  assert.deepEqual(reasons(goodRoutes,goodGate.replace("req.method === 'GET' && ",'')),['the deferred gate does not require GET']);
  assert.deepEqual(reasons(goodRoutes,goodGate.replace('route.deferred','true')),['the deferred gate does not require GET'],'the gate must read the route declaration');
  assert.deepEqual(reasons(goodRoutes,goodGate.replace(' && req.path === route.path','')),['the deferred gate does not match the exact path']);
  assert.deepEqual(reasons(goodRoutes,goodGate.replace('req.path === route.path','req.originalUrl === route.path')),['the deferred gate does not match the exact path']);
  assert.deepEqual(reasons(goodRoutes,goodGate.replace(" && source.breaker?.state === 'closed'",'')),['the deferred gate does not require a closed breaker']);
  assert.deepEqual(reasons(goodRoutes,goodGate.replace('failClosed(res, d); ','')),['the deferred gate does not fail closed']);
  // negative fixtures: the gate and the routes are read as code, not as text (each of these passed the rule that tested each pattern anywhere in the file)
  const [isGet,isDeferred,isPath,isClosed]=["req.method === 'GET'",'route.deferred','req.path === route.path',"source.breaker?.state === 'closed'"],all=[isGet,isDeferred,isPath,isClosed].join(' && ');
  const shaped=(condition,body='{ failClosed(res, d); next(); }')=>'if ('+condition+') '+body+'\n'+mount;
  const noPath=['the deferred gate does not match the exact path'],noFail=['the deferred gate does not fail closed'];
  assert.deepEqual(reasons(goodRoutes,shaped(all)),[],'the same gate is accepted');
  assert.deepEqual(reasons(goodRoutes,shaped('\n  '+all.replaceAll(' && ',' &&\n  ')+'\n')),[],'the gate as Prettier wraps it is accepted');
  assert.deepEqual(reasons(goodRoutes,shaped(all.replace(isDeferred+' && ',isDeferred+' || '))),[DEFERRED_SHAPE],'|| in place of && before the path');
  assert.deepEqual(reasons(goodRoutes,shaped(all.replace(isPath+' && ',isPath+' || '))),[DEFERRED_SHAPE],'|| in place of && before the breaker');
  assert.deepEqual(reasons(goodRoutes,shaped(all+' || bypass')),[DEFERRED_SHAPE],'|| after the last term');
  assert.deepEqual(reasons(goodRoutes,'const closed = '+isClosed+';\n'+shaped([isGet,isDeferred,isPath].join(' && '))),[DEFERRED_SHAPE],'the breaker is computed into a variable and left out of the condition');
  assert.deepEqual(reasons(goodRoutes,'const closed = '+isClosed+';\n'+shaped([isGet,isDeferred,isPath,'closed'].join(' && '))),[DEFERRED_SHAPE],'the breaker is in a variable the condition uses');
  assert.deepEqual(reasons(goodRoutes,shaped(`${isGet} && ${isDeferred} /* && ${isPath} */ && ${isClosed}`)),noPath,'the exact path only in a block comment');
  assert.deepEqual(reasons(goodRoutes,shaped(`\n  ${isGet} &&\n  ${isDeferred} &&\n  // ${isPath} &&\n  ${isClosed}\n`)),noPath,'the exact path only in a line comment');
  assert.deepEqual(reasons(goodRoutes,'// '+gateIf+'\nif (route.deferred) { next(); }\n'+mount),['the deferred gate does not require GET',...noPath,'the deferred gate does not require a closed breaker',...noFail],'the whole gate in a comment while route.deferred opens it');
  assert.deepEqual(reasons(goodRoutes,'/* '+gateIf+' */\nif (route.deferred) { failClosed(res, d); next(); }\n'+mount),['the deferred gate does not require GET',...noPath,'the deferred gate does not require a closed breaker'],'the whole gate in a block comment');
  assert.deepEqual(reasons(goodRoutes,shaped(all,'{ /* failClosed(res, d); */ next(); }')),noFail,'failClosed in a block comment');
  assert.deepEqual(reasons(goodRoutes,shaped(all,'{\n  // failClosed(res, d);\n  next();\n}')),noFail,'failClosed in a line comment');
  assert.deepEqual(reasons(goodRoutes,shaped(all,'{ next(); }')+'\nfailClosed(res, d);'),noFail,'failClosed outside the body of the gate');
  assert.deepEqual(reasons(goodRoutes,gateIf),[MOUNT_MESSAGE],'no mountRoutes');
  assert.deepEqual(reasons(goodRoutes,gateIf+'\n'+mount.replace('pep(route, deps), ','')),[MOUNT_MESSAGE],'mountRoutes without the pep');
  assert.deepEqual(reasons(goodRoutes,gateIf+'\n'+mount.replace('pep(route, deps), ','/* pep(route, deps), */ ')),[MOUNT_MESSAGE],'the pep only in a block comment');
  assert.deepEqual(reasons(goodRoutes,gateIf+'\n'+mount.replace('route.handler)','route.handler); // pep(route, deps)').replace('pep(route, deps), ','')),[MOUNT_MESSAGE],'the pep only in a line comment');
  assert.deepEqual(reasons(goodRoutes,gateIf+'\n'+mount.replace('router[','const guard = pep(route, deps); router[').replace('pep(route, deps), ','')),[MOUNT_MESSAGE],'the pep built and not mounted');
  assert.deepEqual(reasons(goodRoutes,gateIf+'\n'+mount.replace('pep(route, deps), route.handler','route.handler, pep(route, deps)')),[MOUNT_MESSAGE],'the pep after the handler');
  const noRead='res.json(1)',commented=handler=>routesOf(...three.slice(0,2),get('/medical-records/images',true,handler),next);
  assert.deepEqual(reasons(commented(noRead+' /* authorizedRead(res, () => list()) */')),['GET /medical-records/images: GET handler does not use authorizedRead'],'authorizedRead only in a block comment');
  assert.deepEqual(reasons(commented(noRead+' // authorizedRead(res, () => list())')),['GET /medical-records/images: GET handler does not use authorizedRead'],'authorizedRead only in a line comment');
  assert.deepEqual(reasons(routesOf(...three.slice(0,2),'//'+three[2],next)),['deferred route missing: /medical-records/images'],'a deferred route commented out is not declared');
  assert.deepEqual(reasons(routesOf(...three,'//'+get('/dashboard/clinic',true,via),next)),[],'a deferred route that only a comment declares is not there');
  assert.deepEqual(reasons('export const routes = [];\n').slice(0,1),['no route elements found']);
  return DEFERRED_PATHS.length+' deferred routes, all GET via authorizedRead; the gate needs GET, the exact path and a closed breaker';
});

// ---- 10. No duplicated service modules (C) ------------------------------------
// auth.ts and composition.ts were byte-identical in Clinic and Notification until they moved
// into packages/runtime. Identical content in two places is shared code waiting to drift.
const lf = source => source.replace(/\r\n/g, '\n');
export function duplicateModules(modules){
  const groups=new Map();
  for(const {file,source} of modules){const key=lf(source);groups.set(key,[...(groups.get(key)??[]),file]);}
  return [...groups.values()].filter(group=>group.length>1).map(group=>group.join(' = '));
}
rule('no-duplicated-service-modules',()=>{
  const dirs=[...readdirSync(resolve(root,'services'),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>'services/'+e.name+'/src'),...['composition','gateway','workers','routes/internal'].map(d=>'backend/src/'+d)];
  const modules=dirs.flatMap(d=>files(resolve(root,d))).filter(f=>f.endsWith('.ts')&&!f.split(sep).includes('dist')).map(f=>({file:relative(root,f).split(sep).join('/'),source:readFileSync(f,'utf8')}));
  assert.ok(modules.length>=40,'found the service modules ('+modules.length+')');
  const copies=duplicateModules(modules);
  assert.deepEqual(copies,[],'identical modules (move the shared code into packages/runtime or packages/messaging): '+copies.join('; '));
  // negative fixtures: a copy of a real module under another name, with either line ending
  const [first]=modules,copy={file:'services/notification/src/copied.ts',source:first.source};
  assert.deepEqual(duplicateModules([...modules,copy]),[first.file+' = '+copy.file]);
  assert.deepEqual(duplicateModules([...modules,{...copy,source:lf(first.source).replace(/\n/g,'\r\n')}]),[first.file+' = '+copy.file]);
  assert.deepEqual(duplicateModules([{file:'a.ts',source:'x\ny'},{file:'b.ts',source:'x\r\ny'},{file:'c.ts',source:'x\ny '}]),['a.ts = b.ts']);
  assert.deepEqual(duplicateModules(modules.slice(0,5)),[]);
  return modules.length+' modules, none identical';
});

// ---- 11. Service calls are declared (ADR-P13, ADR-P15, K5) ----------------------------------
// Core, Clinic and Notification call each other over HTTP, and the calls form cycles on purpose (ADR-P15). deploy/phase2/service-calls.json
// declares each call (caller, callee, path, credential, timeout, nesting, reason) and every outbound call to a system that is not one of the
// three; tools/phase2/service-calls.mjs reads the code against it (nine points, numbered in its header). This rule replaces
// clinic-core-calls-confined, which only looked at Clinic: its HTTP_CALL, unconfinedHttpCalls and fixtures are kept and now cover the three
// services, and the list of files that may call comes from the json.
const callsCheck=(existsSync(built)?import(pathToFileURL(built).href):Promise.reject(new Error('build packages/contracts first (npm run build -w @nipopeto/contracts)')))
  .then(contracts=>rule('service-calls-declared',()=>{
    const real=callsIo(root),today=new Date().toISOString().slice(0,10),routes=contracts.gatewayRoutes;
    const sources=real.sources();
    assert.ok(sources.length>=100&&['backend/src','services/clinic/src','services/notification/src'].every(d=>sources.some(f=>f.startsWith(d+'/'))),'found the modules of the three services ('+sources.length+')');
    const findings=serviceCallFindings(routes,today,real);
    assert.deepEqual(findings,[],'service calls differ from deploy/phase2/service-calls.json: '+findings.join('; '));
    // the calls of the first rule: outbound HTTP outside the declared files, now in any of the three services
    const declaration=JSON.parse(real.read(DECLARATION)),allowed=new Set([...declaration.calls.map(c=>c.file),...declaration.external.map(x=>x.file)]);
    // The days of the fixtures come from the exception in the declaration (24 days before its last day), so renewing it does not turn a fixture red.
    const addDays=(day,n)=>new Date(Date.parse(day)+n*864e5).toISOString().slice(0,10);
    const UNTIL=declaration.timeoutExceptions[0].until,FIXED=addDays(UNTIL,-24);
    const CLINIC='services/clinic/src/';
    const at=(file,source)=>unconfinedHttpCalls([{file:CLINIC+file,source}],allowed).map(f=>f.slice(CLINIC.length));
    assert.deepEqual(at('app.ts', "const r = await fetch(new URL('/internal/directory/authorize', origin));"), ['app.ts']);
    assert.deepEqual(at('application/services/x.ts', 'await globalThis.fetch(url)'), ['application/services/x.ts']);
    assert.deepEqual(at('x.ts', "import { request } from 'node:https';"), ['x.ts']);
    assert.deepEqual(at('x.ts', "import axios from 'axios';"), ['x.ts']);
    for (const source of [
      "import { connect } from 'node:net';",
      "import tls from 'tls';",
      "import { connect } from 'node:http2';",
      "import { request } from 'undici';",
      "const net = await import('node:net');",
      "const tls = require('node:tls');",
      "import 'node:net';",
      'const get = globalThis.fetch;',
      "const get = globalThis['fetch'];",
    ])
      assert.deepEqual(at('x.ts', source), ['x.ts'], source);
    assert.deepEqual(at('infrastructure/core/directory.ts', 'await fetch(url)'), []);
    assert.deepEqual(at('directory.ts', 'await fetch(url)'), ['directory.ts'], 'the allowance is the path, not the file name');
    assert.deepEqual(at('x.ts', "import { netmask } from './net.js'; const text = 'node:net'; const a = globalThis.fetchedAt;"), []);
    assert.deepEqual(at('x.ts', '// import net from "node:net"' + String.fromCharCode(10) + '/* globalThis.fetch */'), []);
    assert.deepEqual(at('x.ts', '// fetch(url) is what directory.ts does' + String.fromCharCode(10) + '/* fetch(url) */' + String.fromCharCode(10) + 'const fetched = refetch(url);'), []);
    assert.deepEqual(at('x.ts', "const a = 'http://x'; // fetch(a)"), []);
    assert.deepEqual(at('x.ts', "const a = 'a//b'; await fetch(a);"), ['x.ts'], 'a // inside a string does not hide the call after it');
    assert.deepEqual(at('x.ts', "import type { Server } from 'node:http';"), [], 'a type-only import loads no HTTP client');
    assert.deepEqual(at('x.ts', "import type { Server } from 'node:http'; import http from 'node:http';"), ['x.ts'], 'a real import after a type import still counts');
    assert.deepEqual(at('x.ts', "import { type Server } from 'node:http';"), ['x.ts'], 'an inline type specifier still loads the module');
    assert.deepEqual(at('x.ts', 'import type T = NS.T\nconst r = await fetch(u)\nimport x from \'./x\'\n'), ['x.ts'], 'an import type with no semicolon does not swallow the lines after it');
    assert.deepEqual(at('x.ts', "import type, { request } from 'node:https';"), ['x.ts'], 'a default import named type is an import');
    assert.deepEqual(at('x.ts', "import type * as http from 'node:http';"), [], 'a type-only namespace import loads nothing');
    assert.deepEqual(at('x.ts', "import type Http from 'node:http';"), [], 'a type-only default import loads nothing');
    assert.deepEqual(at('x.ts', 'const send = fetch;\nexport const go = (u: string) => send(u);'), ['x.ts'], 'an alias of the global fetch');
    assert.deepEqual(at('x.ts', 'export class S { constructor(private readonly f: typeof fetch = fetch) {} }'), ['x.ts'], 'fetch as a default value');
    assert.deepEqual(at('x.ts', 'export const go = (u: string) => fetch?.(u);'), ['x.ts'], 'an optional call');

    // negative fixtures: each must fail with a finding that starts with the number of its point
    const CB='backend/src/infrastructure/http/clinicBillingRemote.ts',DIR=CLINIC+'infrastructure/core/directory.ts',SYNC=CLINIC+'infrastructure/core/directorySync.ts',
      NA='services/notification/src/coreAuthorization.ts',PROXY='backend/src/gateway/serviceProxy.ts',ROUTES='backend/src/composition/coreRoutes.ts',
      BILLING_ROUTE='backend/src/routes/internal/billing.ts',DIR_ROUTE='backend/src/routes/internal/directory.ts',NA_ROUTE='backend/src/routes/internal/notificationAuthorization.ts',
      CLINIC_API=CLINIC+'http/billingApi.ts',CLINIC_INDEX=CLINIC+'index.ts',CONFIG='backend/src/composition/config.ts',SPEC='packages/contracts/internal/openapi.json',
      BLOB=CLINIC+'infrastructure/blob/blobStore.ts',DECL=DECLARATION,EVIDENCE='clinic-core-billing-evidence',FINALIZE='core-clinic-billing-finalize';
    const run=(files,date=FIXED)=>serviceCallFindings(routes,date,fixtureCallsIo(real,files));
    const edit=(path,from,to)=>{const text=real.read(path);assert.ok(text.includes(from),'fixture edit not found in '+path+': '+from);return {[path]:text.replace(from,()=>to)};};
    const editLast=(path,from,to)=>{const text=real.read(path),i=text.lastIndexOf(from);assert.ok(i>=0,'fixture edit not found in '+path+': '+from);return {[path]:text.slice(0,i)+to+text.slice(i+from.length)};};
    const append=(path,text)=>({[path]:real.read(path)+'\n'+text+'\n'});
    const change=fn=>{const d=structuredClone(declaration);fn(d);return {[DECL]:JSON.stringify(d)};};
    const callOf=(id,fn)=>change(d=>fn(d.calls.find(c=>c.id===id)));
    const specChange=fn=>{const s=JSON.parse(real.read(SPEC));fn(s.paths);return {[SPEC]:JSON.stringify(s)};};
    const fails=[
      // (0) the declaration is read or the rule fails
      ['no declaration file',/^\(0\) cannot read/,run({[DECL]:null})],
      ['a declaration that is not JSON',/^\(0\) cannot read/,run({[DECL]:'{ "calls": '})],
      ['calls that is not an array',/^\(0\) .*calls is not an array/,run(change(d=>{d.calls={};}))],
      ['a timeout that is a string',/^\(0\) .*core-clinic-proxy.*timeoutMs/,run(callOf('core-clinic-proxy',c=>{c.timeoutMs='6000';}))],
      ['a gate that is not one the rule knows',/^\(0\) .*receiver needs a file and a gate/,run(callOf('clinic-core-directory',c=>{c.receiver.gate='trust';}))],
      ['a call with no reason',/^\(0\) .*reason is missing/,run(callOf('clinic-core-directory',c=>{c.reason='';}))],
      ['two calls with one id',/^\(0\) .*listed twice/,run(change(d=>{d.calls.push(structuredClone(d.calls[0]));}))],
      ['a call that names an unknown service',/^\(0\) .*callee needs a service/,run(callOf('clinic-core-directory',c=>{c.callee.service='billing';}))],
      ['a service that calls itself',/^\(0\) .*calls its own service/,run(callOf('clinic-core-directory',c=>{c.callee.service='clinic';}))],
      ['a proxy with a credential',/^\(0\) .*credential of a proxy is null/,run(callOf('core-clinic-proxy',c=>{c.credential={header:'x',token:'y',actor:'none'};}))],
      // (1) every call site is declared, every declared file still calls
      ['a fetch in a new file of Notification',/^\(1\) services\/notification\/src\/relay\.ts makes an outbound HTTP call/,run({'services/notification/src/relay.ts':"export const go = () => fetch('http://core/x');"})],
      ['a fetch in backend/src/application',/^\(1\) backend\/src\/application\/x\.ts makes an outbound HTTP call/,run({'backend/src/application/x.ts':"export const go = () => fetch('http://clinic/x');"})],
      ['a fetch in the Core composition',/^\(1\) backend\/src\/composition\/hook\.ts makes/,run({'backend/src/composition/hook.ts':'export const go = (u: string) => fetch(u);'})],
      ['a fetch in a new Clinic file',/^\(1\) services\/clinic\/src\/application\/services\/x\.ts makes/,run({'services/clinic/src/application/services/x.ts':'export const go = (u: string) => fetch(u);'})],
      ['globalThis.fetch in Notification',/^\(1\) services\/notification\/src\/g\.ts makes/,run({'services/notification/src/g.ts':'export const f = globalThis.fetch;'})],
      ['node:https in Core',/^\(1\) backend\/src\/lib\/h\.ts makes/,run({'backend/src/lib/h.ts':"import { request } from 'node:https';"})],
      ['axios in Notification',/^\(1\) services\/notification\/src\/a\.ts makes/,run({'services/notification/src/a.ts':"import axios from 'axios';"})],
      ['a // in a string before a fetch',/^\(1\) services\/notification\/src\/s\.ts makes/,run({'services/notification/src/s.ts':"const a = 'a//b'; await fetch(a);"})],
      ['a declared call file that no longer calls',/^\(1\) .*directorySync\.ts is declared but makes no outbound HTTP call/,run(edit(SYNC,'const response = await fetch(url, {','const response = await send(url, {'))],
      ['a declared external file that no longer calls',/^\(1\) .*blobStore\.ts is declared but makes no outbound HTTP call/,run(edit(BLOB,'return fetch(this.endpoint.origin','return send(this.endpoint.origin'))],
      ['a declared file outside the services',/^\(1\) tools\/x\.mjs is declared but is not a \.ts file/,run(callOf('clinic-core-directory-export',c=>{c.file='tools/x.mjs';}))],
      ['a file that is both a call file and external',/^\(1\) .* is both a call file and external/,run(change(d=>{d.external.push({...d.external[0],id:'dup',file:d.calls[2].file});}))],
      ['an external file listed twice',/^\(1\) external file .* listed twice/,run(change(d=>{d.external.push({...d.external[0],id:'dup'});}))],
      ['a call file that is not in the src of its caller',/^\(1\) .* is not in the src of its caller/,run(callOf('clinic-core-directory-export',c=>{c.caller.service='notification';}))],
      // (2) paths, suffixes, methods against the caller
      ['a path literal changed in directorySync',/^\(2\) .*directorySync\.ts: the literals .* differ.*exports/,run(edit(SYNC,"'/internal/directory/export'","'/internal/directory/exports'"))],
      ['the evidence path literal changed',/^\(2\) .*directory\.ts: the literals .* differ.*billing-operation\//,run(edit(DIR,"'/internal/billing-operations/'","'/internal/billing-operation/'"))],
      ['the billing path literal changed in Core',/^\(2\) .*clinicBillingRemote\.ts: the literals .* differ/,run(edit(CB,"'/internal/billing-sources/'","'/internal/billing-source/'"))],
      ['a notification path literal changed',/^\(2\) .*coreAuthorization\.ts: the literals .* differ/,run(edit(NA,"'/internal/notifications/authorize-send'","'/internal/notifications/authorise-send'"))],
      ['the suffix authorize changed in the code',/^\(2\) clinic-core-directory: the suffix 'authorize'/,run(edit(DIR,"'authorize'","'authorise'"))],
      ['the suffix commit changed in the code',/^\(2\) core-clinic-billing-finalize: the suffix '\/commit'/,run(edit(CB,"'/commit'","'/comit'"))],
      ['a method changed in the Notification code',/^\(2\) notification-core-authorize-send: the code .* uses PUT, the declaration says POST/,run(edit(NA,"method: 'POST',","method: 'PUT',"))],
      ['a method changed in the Core billing code',/^\(2\) core-clinic-billing-source: the code .* uses POST, the declaration says GET/,run(edit(CB,"'GET', actor)","'POST', actor)"))],
      ['a second call added to a declared Clinic file',/^\(2\) .*directory\.ts: fetch\( number 3 holds none of the declared paths/,run(append(DIR,"export const other = () => fetch('http://core/internal/other');"))],
      ['a second call added to the Notification caller',/^\(2\) .*coreAuthorization\.ts: fetch\( number 2 holds none of the declared paths/,run(append(NA,"export const other = () => fetch('http://clinic/internal/billing-sources/x');"))],
      // (2) every call of a call file is a declared call
      ['a this.call( on a path that no declared call has (the uncalled GET reservation)',/^\(2\) .*clinicBillingRemote\.ts: this\.call\( number \d uses GET but the declared calls that hold its path use PUT/,run(edit(CB,'  async finalize(op: BillingOperationRecord) {',"  async peek(id: string) {\n    return this.call('/internal/billing-reservations/' + encodeURIComponent(id), 'GET');\n  }\n  async finalize(op: BillingOperationRecord) {"))],
      ['a this.call( with a new suffix and method (DELETE .../purge)',/^\(2\) .*clinicBillingRemote\.ts: this\.call\( number \d uses DELETE but the declared calls/,run(edit(CB,'  async finalize(op: BillingOperationRecord) {',"  async purge(id: string) {\n    return this.call('/internal/billing-reservations/' + encodeURIComponent(id) + '/purge', 'DELETE');\n  }\n  async finalize(op: BillingOperationRecord) {"))],
      ['a this.call( on a path of no declared call',/^\(2\) .*clinicBillingRemote\.ts: this\.call\( number \d holds none of the declared paths/,run(edit(CB,'  async finalize(op: BillingOperationRecord) {',"  async other() {\n    return this.call('/internal/other', 'GET');\n  }\n  async finalize(op: BillingOperationRecord) {"))],
      ['a second fetch on a declared path with another method',/^\(2\) .*coreAuthorization\.ts: fetch\( number 2 uses GET but the declared calls that hold its path use POST/,run(append(NA,"export const peek = () => fetch(new URL('/internal/notifications/authorize-send', 'http://core'), { signal: AbortSignal.timeout(2000) });"))],
      ['a method hidden in a spread of the fetch options',/^\(2\) .*directorySync\.ts: fetch\( number 1 uses a method this reader cannot read/,run(edit(SYNC,'const response = await fetch(url, {',"const init = { method: 'DELETE' } as const;\n    const response = await fetch(url, {\n      ...init,"))],
      ['fetch options that are not an object literal',/^\(2\) .*directorySync\.ts: fetch\( number 1 uses a method this reader cannot read/,run(edit(SYNC,'const response = await fetch(url, {','const response = await fetch(url, init ?? {'))],
      ['a computed key in the fetch options',/^\(2\) .*directorySync\.ts: fetch\( number 1 uses a method this reader cannot read/,run(edit(SYNC,'const response = await fetch(url, {',"const response = await fetch(url, {\n      [key]: 'DELETE',"))],
      ['a method that is a variable in the fetch options',/^\(2\) .*directorySync\.ts: fetch\( number 1 uses a method this reader cannot read/,run(edit(SYNC,'const response = await fetch(url, {','const response = await fetch(url, {\n      method: verb,'))],
      ['a declared path that does not start with its match',/^\(2\) clinic-core-directory-export: the declared path \/internal\/other does not start/,run(callOf('clinic-core-directory-export',c=>{c.paths=['/internal/other'];}))],
      ['a match the code does not hold',/^\(2\) core-clinic-billing-source: no fetch\( or this\.call\(/,run(callOf('core-clinic-billing-source',c=>{c.match='/internal/billing-sourcez/';c.paths=['/internal/billing-sourcez/:id'];}))],
      // (3) /internal named only where it is declared
      ['a proxy file that names /internal',/^\(3\) backend\/src\/gateway\/serviceProxy\.ts holds a literal/,run(edit(PROXY,'const url = new URL(req.originalUrl, target.origin);',"const url = new URL(req.originalUrl.replace('/api/x', '/internal/billing-reservations'), target.origin);"))],
      ['two ${…} before /internal',/^\(3\) services\/clinic\/src\/application\/p\.ts holds a literal/,run({[CLINIC+'application/p.ts']:'export const p = (a: string, b: string) => `${a}${b}/internal/directory/export`;'})],
      ['a literal /internal in another Core file',/^\(3\) backend\/src\/application\/y\.ts holds a literal/,run({'backend/src/application/y.ts':"export const p = '/internal/directory/authorize';"})],
      ['a literal /internal in Notification',/^\(3\) services\/notification\/src\/z\.ts holds a literal/,run({'services/notification/src/z.ts':'export const p = `/internal/x/${1}`;'})],
      ['the literal /internal alone in Clinic',/^\(3\) services\/clinic\/src\/domain\/z\.ts holds a literal/,run({'services/clinic/src/domain/z.ts':"export const base = '/internal';"})],
      // (4) paths against the routes of the receiver and the internal OpenAPI file
      ['a declared path that is not a route',/^\(4\) clinic-core-directory-export: GET \/internal\/directory\/export\/nope is not a route/,run(callOf('clinic-core-directory-export',c=>{c.match='/internal/directory/export';c.paths=['/internal/directory/export','/internal/directory/export/nope'];}))],
      ['a declared method that the route does not have',/^\(4\) clinic-core-billing-evidence: PUT .* is not a route of backend\/src\/routes\/internal\/billing\.ts/,run(callOf(EVIDENCE,c=>{c.method='PUT';}))],
      ['a declared path missing from the internal OpenAPI file',/^\(4\) clinic-core-directory: POST \/internal\/directory\/lookup is not an operation of/,run(specChange(p=>{delete p['/internal/directory/lookup'];}))],
      ['an operation of the internal OpenAPI file that no receiver has',/^\(4\) operation GET \/internal\/ghost\/\{\} of .* is a route of no declared receiver/,run(specChange(p=>{p['/internal/ghost/{id}']={get:{}};}))],
      ['a route in a receiver that the OpenAPI file lacks',/^\(4\) route GET \/internal\/directory\/extra is in a receiver file but not in/,run(append(DIR_ROUTE,"app.get('/internal/directory/extra', (_req, res) => res.json({}));"))],
      ['the ${action} of the Clinic routes cannot be opened',/^\(4\) .*billingApi\.ts: route POST .*cannot open \$\{action\}/,run(edit(CLINIC_API,"for (const action of ['commit', 'release'] as const)",'for (const action of actions)'))],
      ['a route with a path that is not a literal',/^\(4\) .*directory\.ts: 1 route\(s\) whose path is not a string literal/,run(append(DIR_ROUTE,'app.get(EXTRA_PATH, handler);'))],
      ['a route form the reader does not follow',/^\(4\) .*directory\.ts: app\.all\( or \.route\(/,run(append(DIR_ROUTE,"app.route('/internal/directory/x').get(handler);"))],
      ['a proxy that declares a prefix the contracts do not give its service',/^\(4\) core-clinic-proxy: the declared prefixes/,run(callOf('core-clinic-proxy',c=>{c.paths=['/api/appointments','/api/medical-records'];}))],
      ['a receiver file that is not in the src of its callee',/^\(4\) .* is not in the src of its callee/,run(callOf('clinic-core-directory-export',c=>{c.receiver.file='services/clinic/src/http/billingApi.ts';}))],
      ['a receiver file that does not exist',/^\(4\) receiver file .* cannot be read/,run(callOf('clinic-core-directory-export',c=>{c.receiver.file='backend/src/routes/internal/missing.ts';}))],
      // (5) every /internal route has a caller or a reason
      ['a new Core route that nobody calls',/^\(5\) route GET \/internal\/directory\/extra of backend\/src\/routes\/internal\/directory\.ts has no declared call/,run(append(DIR_ROUTE,"app.get('/internal/directory/extra', (_req, res) => res.json({}));"))],
      ['a new Clinic route that nobody calls',/^\(5\) route GET \/internal\/billing-extra\/\{\} of services\/clinic\/src\/http\/billingApi\.ts has no declared call/,run(edit(CLINIC_API,"router.get('/billing-sources/:id'","router.get('/billing-extra/:id', async () => undefined);\n  router.get('/billing-sources/:id'"))],
      ['the uncalled route loses its entry',/^\(5\) route GET \/internal\/billing-reservations\/\{\} of .* has no declared call/,run(change(d=>{d.uncalledRoutes=[];}))],
      ['an uncalled entry for a route that now has a caller',/^\(5\) uncalledRoutes POST \/internal\/billing-reservations\/\{\}\/commit \(clinic\): stale, a declared call/,run(change(d=>{d.uncalledRoutes.push({callee:'clinic',method:'POST',path:'/internal/billing-reservations/:operationId/commit',reason:'a reason that is long enough'});}))],
      ['an uncalled entry for a route that does not exist',/^\(5\) uncalledRoutes GET \/internal\/nothing\/\{\} \(clinic\): stale, no receiver/,run(change(d=>{d.uncalledRoutes.push({callee:'clinic',method:'GET',path:'/internal/nothing/:id',reason:'a reason that is long enough'});}))],
      ['an uncalled entry listed twice',/^\(5\) uncalledRoutes .* listed twice/,run(change(d=>{d.uncalledRoutes.push(structuredClone(d.uncalledRoutes[0]));}))],
      ['an uncalled entry for the wrong callee',/^\(5\) uncalledRoutes .*\(core\): stale, no receiver/,run(change(d=>{d.uncalledRoutes[0].callee='core';}))],
      ['an uncalled entry with no reason',/^\(0\) .*uncalledRoutes\[0\] needs callee, method, path and a reason/,run(change(d=>{d.uncalledRoutes[0].reason='';}))],
      // (6) the declared timeout is the one of the code
      ['the evidence timeout changed in the code',/^\(6\) clinic-core-billing-evidence: declared timeout 2000 ms, the code says 1500 ms/,run(edit(DIR,'AbortSignal.timeout(2000)','AbortSignal.timeout(1500)'))],
      ['the directory timeout changed in the code',/^\(6\) clinic-core-directory: declared timeout 2000 ms, the code says 2500 ms/,run(editLast(DIR,'AbortSignal.timeout(2000)','AbortSignal.timeout(2500)'))],
      ['the billing default timeout changed',/^\(6\) core-clinic-billing-source: declared timeout 1800 ms, the code says 2500 ms \(default of timeout\)/,run(edit(CB,'private readonly timeout = 1800,','private readonly timeout = 2500,'))],
      ['the Clinic proxy timeout changed',/^\(6\) core-clinic-proxy: declared timeout 6000 ms, the code says 7000 ms/,run(edit(ROUTES,'timeoutMs: 6000,','timeoutMs: 7000,'))],
      ['the Notification proxy timeout changed',/^\(6\) core-notification-proxy: declared timeout 4000 ms, the code says 5000 ms/,run(edit(ROUTES,'timeoutMs: 4000,','timeoutMs: 5000,'))],
      ['the export timeout changed',/^\(6\) clinic-core-directory-export: declared timeout 2000 ms, the code says 3000 ms/,run(edit(SYNC,'AbortSignal.timeout(2000)','AbortSignal.timeout(3000)'))],
      ['the authorize-send default timeout changed',/^\(6\) notification-core-authorize-send: declared timeout 2000 ms, the code says 2500 ms/,run(edit(NA,'private readonly timeoutMs = 2000,','private readonly timeoutMs = 2500,'))],
      ['a declared timeout that the code does not have',/^\(6\) clinic-core-directory-export: declared timeout 2500 ms, the code says 2000/,run(callOf('clinic-core-directory-export',c=>{c.timeoutMs=2500;}))],
      ['a fetch with no timeout',/^\(6\) core-clinic-proxy: the fetch\( of .* has no AbortSignal\.timeout/,run(edit(PROXY,'signal: AbortSignal.timeout(target.timeoutMs),',''))],
      ['a timeout the reader cannot read',/^\(6\) clinic-core-directory-export: cannot read the timeout from AbortSignal\.timeout\(LIMIT\)/,run(edit(SYNC,'AbortSignal.timeout(2000)','AbortSignal.timeout(LIMIT)'))],
      ['a serviceProxy that is not in the config file',/^\(6\) core-clinic-proxy: .* holds 0 serviceProxy/,run(callOf('core-clinic-proxy',c=>{c.config.proxy='archive';}))],
      // (7) nested timeouts
      ['an exception past its date',new RegExp('^\\(7\\) exception core-clinic-billing-finalize > clinic-core-billing-evidence: expired on '+UNTIL),run({},addDays(UNTIL,1))],
      ['an exception that no longer applies',/^\(7\) exception .*stale, the inner timeout/,run(callOf(EVIDENCE,c=>{c.timeoutMs=1500;}))],
      ['the exception was written for other timeouts (the evidence timeout grew)',/^\(7\) exception .*written for 2000 ms inside 1800 ms, the timeouts are now 2500 ms inside 1800 ms/,run({...edit(DIR,'AbortSignal.timeout(2000)','AbortSignal.timeout(2500)'),...callOf(EVIDENCE,c=>{c.timeoutMs=2500;})})],
      ['an exception with no pinned timeouts',/^\(0\) .*timeoutExceptions\[0\] needs outer and inner ids and the timeouts/,run(change(d=>{delete d.timeoutExceptions[0].innerMs;}))],
      ['a call to another service from an external file, written after a host',/^\(3\) .*blobStore\.ts holds a literal/,run(append(BLOB,"export const sneak = () => send('http://core/internal/directory/export');"))],
      ['an exception with no reason',/^\(7\) exception .*no reason/,run(change(d=>{d.timeoutExceptions[0].reason='';}))],
      ['an exception more than 60 days ahead',/^\(7\) exception .*more than 60 days/,run(change(d=>{d.timeoutExceptions[0].until=addDays(FIXED,61);}))],
      ['an exception with a day that does not exist',/^\(7\) exception .*until is not a date/,run(change(d=>{d.timeoutExceptions[0].until='2026-02-30';}))],
      ['an exception for a call that is not declared',/^\(7\) exception .*a call id is not declared/,run(change(d=>{d.timeoutExceptions[0].inner='ghost';}))],
      ['an exception listed twice',/^\(7\) exception .*duplicate exception/,run(change(d=>{d.timeoutExceptions.push(structuredClone(d.timeoutExceptions[0]));}))],
      ['an exception for a pair that is not nested',/^\(7\) exception .* is not nested in/,run(change(d=>{d.timeoutExceptions[0].inner='clinic-core-directory-export';}))],
      ['a nested call with no exception',/^\(7\) clinic-core-billing-evidence: timeout 2000 ms is not shorter than core-clinic-billing-finalize \(1800 ms\)/,run(change(d=>{d.timeoutExceptions=[];}))],
      ['nested timeouts reversed: the directory call outlasts its proxy',/^\(7\) clinic-core-directory: timeout 2000 ms is not shorter than core-clinic-proxy \(1500 ms\)/,run(callOf('core-clinic-proxy',c=>{c.timeoutMs=1500;}))],
      ['a call nested in a call that does not reach its caller',/^\(7\) clinic-core-directory: nested in core-notification-proxy/,run(callOf('clinic-core-directory',c=>{c.nestedIn='core-notification-proxy';}))],
      ['a call nested in an id that is not declared',/^\(7\) clinic-core-directory: nestedIn ghost is not a declared call/,run(callOf('clinic-core-directory',c=>{c.nestedIn='ghost';}))],
      // (8) credentials
      ['a token that is not in the scoped list',/^\(8\) clinic-core-directory-export: token CORE_OTHER_TOKEN is not in the scoped list/,run(callOf('clinic-core-directory-export',c=>{c.credential.token='CORE_OTHER_TOKEN';}))],
      ['two receivers opened by one token',/^\(8\) token CORE_DIRECTORY_TOKEN opens more than one receiver/,run(callOf(EVIDENCE,c=>{c.credential.token='CORE_DIRECTORY_TOKEN';}))],
      ['a receiver called with two tokens',/^\(8\) receiver .*directory\.ts is called with more than one token/,run(callOf('clinic-core-directory-export',c=>{c.credential.token='CORE_BILLING_EVIDENCE_TOKEN';}))],
      ['a token renamed in the caller code',/^\(8\) clinic-core-billing-evidence: token CORE_BILLING_EVIDENCE_TOKEN is not named in services\/clinic\/src\/index\.ts, where the caller clinic reads it/,run(edit(CLINIC_INDEX,"credential('CORE_BILLING_EVIDENCE_TOKEN')","credential('CORE_EVIDENCE_TOKEN')"))],
      ['a token dropped from the scoped list',/^\(8\) notification-core-authorize-send: token CORE_NOTIFICATION_SEND_TOKEN is not in the scoped list/,run(edit(CONFIG,"'CORE_NOTIFICATION_SEND_TOKEN',",''))],
      ['the scoped list cannot be read',/^\(8\) cannot read the scoped credentials list/,run(edit(CONFIG,'const scoped = [','const scopedList = ['))],
      ['a token named only in the caller',/^\(8\) core-clinic-billing-source: token CLINIC_BILLING_TOKEN is not named in services\/clinic\/src\/index\.ts, where the callee clinic reads it/,run({[CLINIC_INDEX]:real.read(CLINIC_INDEX).replaceAll('CLINIC_BILLING_TOKEN','CLINIC_BILLING_TOKEN_X')})],
      ['a token that the caller wiring file does not name',/^\(8\) clinic-core-directory-export: token CORE_DIRECTORY_TOKEN is not named in services\/clinic\/src\/application\/services\/bookingLifecycle\.ts, where the caller clinic reads it/,run(callOf('clinic-core-directory-export',c=>{c.credential.wiring.caller=CLINIC+'application\/services\/bookingLifecycle.ts';}))],
      ['a wiring file outside the service it belongs to',/^\(8\) clinic-core-directory-export: the caller wiring file backend\/src\/composition\/config\.ts is not in the src of clinic/,run(callOf('clinic-core-directory-export',c=>{c.credential.wiring.caller=CONFIG;}))],
      ['a credential with no wiring',/^\(0\) .*credential needs header, token, actor .* and wiring/,run(callOf('clinic-core-directory-export',c=>{delete c.credential.wiring;}))],
      ['the token of one service renamed only in its Core config (callee wiring)',/^\(8\) clinic-core-directory: token CORE_DIRECTORY_TOKEN is not named in backend\/src\/composition\/config\.ts, where the callee core reads it/,run({[CONFIG]:real.read(CONFIG).replaceAll('CORE_DIRECTORY_TOKEN','CORE_DIR_TOKEN')})],
      ['a proxy that forwards another header',/^\(8\) core-clinic-proxy: the proxy forwards \[authorization, idempotency-key, cookie\]/,run(edit(ROUTES,"forwardRequestHeaders: ['authorization', 'idempotency-key'],","forwardRequestHeaders: ['authorization', 'idempotency-key', 'cookie'],"))],
      ['the service header renamed in a caller',/^\(8\) notification-core-authorize-send: the header x-service-token is not named in services\/notification\/src\/coreAuthorization\.ts/,run(edit(NA,"'X-Service-Token': this.credential,","'X-Svc': this.credential,"))],
      ['the signed actor no longer signed',/^\(8\) core-clinic-billing-source: declared with a signed actor/,run(edit(CB,'signToken(actor.sub, actor.role)','makeToken(actor.sub, actor.role)'))],
      ['a bearer actor with no Authorization header',/^\(8\) clinic-core-directory-export: declared with a bearer actor/,run(callOf('clinic-core-directory-export',c=>{c.credential.actor='bearer';}))],
      // (9) the receiver applies its gate
      ['the evidence route loses its credential check',/^\(9\) receiver backend\/src\/routes\/internal\/billing\.ts does not apply its gate acceptsCredential/,run(edit(BILLING_ROUTE,'acceptsCredential(req.headers','check(req.headers'))],
      ['the directory routes lose credentialGate',/^\(9\) receiver backend\/src\/routes\/internal\/directory\.ts does not apply its gate credentialGate/,run(edit(DIR_ROUTE,"app.use('/internal/directory', credentialGate(credential));",''))],
      ['the Clinic billing router loses acceptsService',/^\(9\) receiver .*billingApi\.ts does not apply its gate acceptsService/,run(edit(CLINIC_API,'source.acceptsService(','source.accepts('))],
      ['the authorize-send route loses its credential check',/^\(9\) receiver .*notificationAuthorization\.ts does not apply its gate acceptsCredential/,run(edit(NA_ROUTE,'acceptsCredential(req.headers','check(req.headers'))],
      // the review of C5
      ['a fetch in a .mts file',/^\(1\) services\/clinic\/src\/application\/relay\.mts makes/,run({[CLINIC+'application/relay.mts']:'export const r = (u: string) => fetch(u);'})],
      ['a fetch in a .cts file',/^\(1\) services\/notification\/src\/relay\.cts makes/,run({'services/notification/src/relay.cts':'export const r = (u: string) => fetch(u);'})],
      ['a fetch in a generated folder that is not the root one',/^\(1\) services\/clinic\/src\/application\/generated\/x\.ts makes/,run({[CLINIC+'application/generated/x.ts']:'export const r = () => fetch(u);'})],
      ['a fetch aliased in Notification',/^\(1\) services\/notification\/src\/send\.ts makes/,run({'services/notification/src/send.ts':'const send = fetch;\nexport const go = (u: string) => send(u);'})],
      ['an optional call fetch?.( in Notification',/^\(1\) services\/notification\/src\/o\.ts makes/,run({'services/notification/src/o.ts':'export const go = (u: string) => fetch?.(u);'})],
      ['a call file that imports node:https as well',/^\(1\) clinic-core-directory-export: .*directorySync\.ts imports an HTTP client module/,run(append(SYNC,"import { request } from 'node:https';"))],
      ['a call file that imports axios',/^\(1\) notification-core-authorize-send: .*coreAuthorization\.ts imports an HTTP client module/,run(append(NA,"import axios from 'axios';"))],
      ['the default of the timeout is not a constructor parameter',/^\(6\) core-clinic-billing-source: the default of timeout is not a constructor parameter/,run(edit(CB,'export class ClinicBillingRemote implements BillingRemote {','export const ClinicBillingRemote = class implements BillingRemote {'))],
      ['Core builds ClinicBillingRemote with a timeout of its own (coreRoutes)',/^\(6\) core-clinic-billing-source: backend\/src\/composition\/coreRoutes\.ts: new ClinicBillingRemote\( passes 3 arguments, argument 3 overrides the default of timeout/,run(edit(ROUTES,'new ClinicBillingRemote(clinic, config.clinicToken!)','new ClinicBillingRemote(clinic, config.clinicToken!, 5000)'))],
      ['the core-billing worker builds it with a timeout of its own',/^\(6\) core-clinic-billing-prepare: backend\/src\/workers\/billing\.ts: new ClinicBillingRemote\( passes 3 arguments/,run(edit('backend/src/workers/billing.ts','new ClinicBillingRemote(target, credential)','new ClinicBillingRemote(target, credential, 5000)'))],
      ['Notification builds CoreSendAuthorization with a timeout of its own',/^\(6\) notification-core-authorize-send: services\/notification\/src\/index\.ts: new CoreSendAuthorization\( passes 3 arguments/,run(edit('services/notification/src/index.ts','new CoreSendAuthorization(process.env.CORE_SERVICE_URL, token!)','new CoreSendAuthorization(process.env.CORE_SERVICE_URL, token!, 9000)'))],
      ['a construction with a spread argument',/^\(6\) notification-core-authorize-send: .* with a spread argument/,run(edit('services/notification/src/index.ts','new CoreSendAuthorization(process.env.CORE_SERVICE_URL, token!)','new CoreSendAuthorization(...args)'))],
      ['the router is assigned to another name',/^\(4\) .*directory\.ts: the router is named r, not router/,run(append(DIR_ROUTE,"export function more(app: Express) { const r = express.Router(); r.get('/internal/directory/dump', (_q, s) => s.json({})); app.use(r); }"))],
      ['a second mount of the router',/^\(4\) .*billingApi\.ts: 2 mounts of router/,run(edit(CLINIC_API,"app.use('/internal', router);","app.use('/internal', router);\n  app.use('/api/billing', router);"))],
      ['the router mounted without a prefix',/^\(4\) .*billingApi\.ts: the mount of router is not/,run(edit(CLINIC_API,"app.use('/internal', router);",'app.use(router);'))],
      ['a route on an object that is not app or router',/^\(4\) .*directory\.ts: server\.get\('\/internal…' is a route on an object/,run(append(DIR_ROUTE,"export function more(server: Express) { server.get('/internal/directory/dump', (_q, s) => s.json({})); }"))],
      ['a route written as app[\'get\'](',/^\(4\) .*directory\.ts: app\['get'\]\( is a route written in a form/,run(append(DIR_ROUTE,"export function more(app: Express) { app['get']('/internal/directory/dump', (_q: any, s: any) => s.json({})); }"))],
      ['the core-billing worker reads another token name',/^\(8\) core-clinic-billing-source: token CLINIC_BILLING_TOKEN is not named in backend\/src\/workers\/billing\.ts, where the caller core reads it/,run(edit('backend/src/workers/billing.ts','process.env.CLINIC_BILLING_TOKEN ?? ','process.env.CLINIC_TOKEN ?? '))],
      ['a wiring list that is empty',/^\(0\) .*credential needs header, token, actor/,run(callOf('core-clinic-billing-source',c=>{c.credential.wiring.caller=[];}))],
      ['the signed actor sends no Authorization header',/^\(8\) core-clinic-billing-source: declared with a signed actor/,run(edit(CB,"...(actor ? { Authorization: 'Bearer ' + signToken(actor.sub, actor.role) } : {}),","...(actor ? { 'X-Actor': signToken(actor.sub, actor.role) } : {}),"))],
      ['credentialGate mounted on another prefix',/^\(9\) receiver .*directory\.ts: credentialGate guards '\/internal\/directory-old' but the declared path/,run(edit(DIR_ROUTE,"app.use('/internal/directory', credentialGate(credential));","app.use('/internal/directory-old', credentialGate(credential));"))],
      ['credentialGate with a prefix that is not a literal',/^\(9\) receiver .*directory\.ts: the prefix of credentialGate is not a string literal/,run(edit(DIR_ROUTE,"app.use('/internal/directory', credentialGate(credential));",'app.use(PREFIX, credentialGate(credential));'))],
      ['credentialGate mounted after the routes',/^\(9\) receiver .*directory\.ts: a route is mounted before credentialGate/,run({[DIR_ROUTE]:real.read(DIR_ROUTE).replace("  app.use('/internal/directory', credentialGate(credential));","").replace("app.get('/internal/directory/export', exportHandler(reader));","app.get('/internal/directory/export', exportHandler(reader));\n  app.use('/internal/directory', credentialGate(credential));")})],
    ];
    for(const [reason,tag,found] of fails)assert.ok(found.some(f=>tag.test(f)),'must fail ('+tag+'): '+reason+(found.length?'; got '+found.slice(0,3).join(' | '):'; got nothing'));
    // must pass: text a careless reader misreads
    const lf2crlf=path=>({[path]:real.read(path).replace(/\r?\n/g,'\r\n')});
    const passes={
      'a comment with fetch( in Notification':run({'services/notification/src/c.ts':'// await fetch(url) is what coreAuthorization.ts does\n/* fetch(url) */\nexport const f = refetch(prefetch(1));'}),
      'a comment naming /internal/ in a Core file':run({'backend/src/application/c.ts':"// the route '/internal/directory/authorize' is Core's\nexport const a = 1;"}),
      'a string with /internal/ in a test, which is not under a src':run({'services/clinic/tests/x.ts':"export const p = '/internal/billing-sources/x'; await fetch(p);",'backend/tests/y.ts':"fetch('/internal/x');"}),
      'a type-only import of node:http in Core':run({'backend/src/lib/t.ts':"import type { Server } from 'node:http';\nexport type S = Server;"}),
      'an import path that contains /internal/':run({'backend/src/composition/i.ts':"import { x } from '../routes/internal/billing.js';"}),
      'a file under generated/ with a fetch':run({'services/clinic/src/generated/client/x.ts':'export const f = (u: string) => fetch(u);'}),
      'CRLF line endings in the callers':run({...lf2crlf(CB),...lf2crlf(DIR),...lf2crlf(SYNC),...lf2crlf(NA)}),
      'CRLF line endings in the receivers':run({...lf2crlf(BILLING_ROUTE),...lf2crlf(DIR_ROUTE),...lf2crlf(NA_ROUTE),...lf2crlf(CLINIC_API)}),
      'a new file with a fetch that the declaration lists as external':run({'services/notification/src/push.ts':'export const go = (u: string) => fetch(u);',...change(d=>{d.external.push({id:'push',service:'notification',file:'services/notification/src/push.ts',system:'a push provider',reason:'a third-party system, not a service'});})}),
      'a type-only import of node:http in a call file':run(append(NA,"import type { Server } from 'node:http';")),
      'a fetch in <src>/generated (the Prisma client)':run({'services/clinic/src/generated/x.ts':'export const r = (u: string) => fetch(u);'}),
      'a router mounted once with a prefix, and routes on app and router':run(append(DIR_ROUTE,"export const unrelated = (app: Express) => app.get('/api/x', h);")),
      'the exception on its last day':run({},UNTIL),
      'the exception 60 days ahead (the last day that is not too far)':run(change(d=>{d.timeoutExceptions[0].until=addDays(FIXED,60);})),
      'a route that is only used as a setting (app.get with a string)':run(append(DIR_ROUTE,"const setting = app.get('trust proxy');")),
    };
    for(const [reason,found] of Object.entries(passes))assert.deepEqual(found,[],'must pass: '+reason+': '+found.join('; '));
    // the reader of routes
    assert.deepEqual(routesIn("app.get('/internal/a/:id', h); app.post(\n  '/internal/b', h); app.get('/api/x', h);").routes,[{method:'GET',path:'/internal/a/:id'},{method:'POST',path:'/internal/b'}],'app routes under /internal only');
    assert.deepEqual(routesIn("const router = express.Router(); router.get('/a', h); for (const x of ['u','v']) router.post(`/b/${x}`, h); app.use('/internal', router);").routes,[{method:'GET',path:'/internal/a'},{method:'POST',path:'/internal/b/u'},{method:'POST',path:'/internal/b/v'}],'router routes behind a mount, ${x} opened from its loop');
    assert.deepEqual(routesIn("router.get('/a', h);").routes,[],'a router with no /internal mount has no /internal route');
    // the metric: a clean tree has no unchecked direction, and an undeclared call, a finding on a call or no declaration shows
    const metric=(files,date=FIXED)=>serviceCallMetrics(routes,date,fixtureCallsIo(real,files));
    assert.deepEqual([metric({}).uncheckedDirections,metric({}).undeclaredCallSites],[0,0],'the real tree');
    assert.deepEqual([metric({'backend/src/application/x.ts':'export const f = (u: string) => fetch(u);'}).uncheckedDirections,metric({'backend/src/application/x.ts':'export const f = (u: string) => fetch(u);'}).undeclaredCallSites],[0,1],'an undeclared call site');
    assert.equal(metric(edit(NA,'private readonly timeoutMs = 2000,','private readonly timeoutMs = 2500,')).uncheckedDirections,1,'a finding on one call leaves its direction unchecked');
    assert.deepEqual([metric({[DECL]:null}).uncheckedDirections,metric({[DECL]:null}).undeclaredCallSites],[4,7],'no declaration: every direction unchecked, every call site undeclared');
    assert.equal(metric({},addDays(UNTIL,1)).uncheckedDirections,0,'an expired exception does not move the metric');
    return declaration.calls.length+' calls in '+serviceCallMetrics(routes,today,real).detail.directions.filter(d=>d.calls.length).length+' directions, '+declaration.external.length+' external, '+declaration.uncalledRoutes.length+' uncalled route, '+declaration.timeoutExceptions.length+' timeout exception ('+callExceptionDays(today,real).join('; ')+'); '+fails.length+' must-fail, '+Object.keys(passes).length+' must-pass, the call-site fixtures of the first rule and 3 reader fixtures';
  }),error=>rule('service-calls-declared',()=>{throw error;}));

// ---- 13. Shared packages carry no business route -------------------------------------------
// packages/* (the declaration of the API in contracts excepted) never name a route of a service: a literal path under
// /api/, /auth/ or /public/, as a string or inside a regular expression. A service tells the shared runtime its own
// limit rules, body limits and metric labels (RuntimeOptions). The bare mount prefix '/api' is not a route.
const BUSINESS_ROUTE_LITERAL = /(?<![\w.$])\\?\/(?:api|auth|public)\\?\//;
export function businessRouteLiterals(modules) {
  return modules.flatMap(m =>
    withoutComments(m.source)
      .split('\n')
      .flatMap((line, i) => (BUSINESS_ROUTE_LITERAL.test(line) ? [m.file + ':' + (i + 1)] : [])),
  );
}
rule('shared-packages-no-business-routes', () => {
  const packages = readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'contracts').map(e => e.name);
  const modules = packages.flatMap(name => files(resolve(root, 'packages', name, 'src')).filter(f => f.endsWith('.ts')).map(f => ({ file: relative(root, f).split(sep).join('/'), source: readFileSync(f, 'utf8') })));
  assert.ok(modules.length >= 20 && packages.includes('runtime') && packages.includes('messaging'), 'found the shared package modules (' + modules.length + ')');
  const found = businessRouteLiterals(modules);
  assert.deepEqual(found, [], 'a shared package names a service route (pass it from the service through RuntimeOptions): ' + found.join(', '));
  // negative fixtures
  const at = source => businessRouteLiterals([{ file: 'x.ts', source }]);
  for (const source of [
    "app.use('/api/auth', express.json());",
    'if (p.startsWith("/public/pets/")) return 1;',
    'const route = `/api/pets/${id}`;',
    'const fixed = /^\\/api\\/(pets|owners)$/;',
    'const login = /^\\/auth\\/(owner|admin)\\/login$/;',
    "return req.path === '/auth/me/password';",
    "const p = '/api/health';\nconst q = '/api/auth/login';",
  ])
    assert.notDeepEqual(at(source), [], source);
  assert.deepEqual(at("const r = '/api/pets/x'; const l = 3;\nconst bad = '/auth/x';"), ['x.ts:1', 'x.ts:2']);
  for (const source of [
    "app.use('/api', limiter);",
    "const prefix = '/api';",
    "import { x } from '../auth/token.js';",
    "import { y } from './api/client.js';",
    "const a = '/health/live', b = '/internal/', c = '/metrics';",
    "// the route '/api/auth/login' is Core's",
    '/* /public/pets/:token is Core\'s, and so is /api/pets/ */',
    "const note = 'authentication';",
  ])
    assert.deepEqual(at(source), [], source);
  return modules.length + ' modules in ' + packages.join(', ') + '; no route literal';
});

// ---- 14. Every service passes its limit rules to the runtime -----------------------------------
// RuntimeOptions.limitRules is required, and createRuntime refuses to start without it; this rule makes the omission
// visible before anything runs: each createRuntime call site in the services names limitRules (an empty list is a choice).
const CREATE_RUNTIME = /\bcreateRuntime\s*\(/;
export function runtimesWithoutLimitRules(modules) {
  return modules.filter(m => CREATE_RUNTIME.test(withoutComments(m.source)) && !/\blimitRules\s*:/.test(withoutComments(m.source))).map(m => m.file);
}
rule('services-declare-limit-rules', () => {
  const modules = ['backend/src', ...readdirSync(resolve(root, 'services'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => 'services/' + e.name + '/src')]
    .flatMap(d => files(resolve(root, d)).filter(f => f.endsWith('.ts')).map(f => ({ file: relative(root, f).split(sep).join('/'), source: readFileSync(f, 'utf8') })));
  const sites = modules.filter(m => CREATE_RUNTIME.test(withoutComments(m.source)));
  assert.ok(sites.length >= 3, 'found the createRuntime call sites of Core, Clinic and Notification (' + sites.map(m => m.file).join(', ') + ')');
  const missing = runtimesWithoutLimitRules(modules);
  assert.deepEqual(missing, [], 'createRuntime without limitRules (pass [] if the service has no rule of its own): ' + missing.join(', '));
  // negative fixtures
  const at = source => runtimesWithoutLimitRules([{ file: 'x.ts', source }]);
  assert.deepEqual(at("createRuntime({ service: 'core', verify, probe })"), ['x.ts']);
  assert.deepEqual(at("createRuntime({ service: 'core', verify, probe, // limitRules: coreLimitRules,\n })"), ['x.ts'], 'a commented rule list is not a rule list');
  assert.deepEqual(at("createRuntime({ service: 'clinic', verify, limitRules: [], probe })"), []);
  assert.deepEqual(at("createRuntime({ service: 'core', verify,\n limitRules: coreLimitRules })"), []);
  assert.deepEqual(at("const unrelated = 1;"), []);
  return sites.length + ' call sites: ' + sites.map(m => m.file).join(', ');
});

// ---- 15. Clinic routes are declared with their scope (K2) ---------------------------------
// Every Clinic route is an element of the registry (http/routes/*.ts) that mountRoutes mounts behind its PEP; a route declared any
// other way would run without the scope its URL names. So the registry files, http/scope.ts and app.ts call no router.get, post,
// patch, put, delete or all (router.use stays: it is the middleware before the routes, and mountRoutes reaches the router as
// router[route.method]), and every element names its `resource` before its handler (assertRoutes refuses one at startup; this
// refuses it before the server starts). http/billingApi.ts is not scanned: the internal billing API is service-to-service, outside the PEP.
const ROUTER_METHOD_CALL=/\brouter\s*\.\s*(?:get|post|patch|put|delete|all)\s*\(/g;
const ROUTE_ELEMENT=/\{\s*method:\s*'(?:get|post|patch|put|delete|all)'\s*,/g;
const lineOf=(source,index)=>source.slice(0,index).split('\n').length;
export const routeElements=source=>[...withoutComments(source).matchAll(ROUTE_ELEMENT)];
export function routeScopeViolations(source){
  const code=withoutComments(source),found=[],starts=routeElements(source);
  for(const m of code.matchAll(ROUTER_METHOD_CALL))found.push('line '+lineOf(code,m.index)+': '+m[0].replace(/\s+/g,'')+' declares a route outside the registry');
  starts.forEach((m,i)=>{
    const text=code.slice(m.index,starts[i+1]?.index??code.length),declaration=text.split(/\bhandler\b/)[0];
    if(!/\bresource\s*:/.test(declaration))found.push('line '+lineOf(code,m.index)+': route '+(text.match(/\bmethod:\s*'(\w+)'/)?.[1]??'?')+' '+(text.match(/\bpath:\s*'([^']+)'/)?.[1]??'?')+' declares no resource');
  });
  return found;
}
rule('clinic-routes-declare-scope',()=>{
  const routeFiles=readdirSync(resolve(clinicSrc,'http/routes')).filter(f=>f.endsWith('.ts')).sort().map(f=>'http/routes/'+f);
  const scanned=[...routeFiles,'http/scope.ts','app.ts'],sources=scanned.map(f=>({file:f,source:readFileSync(resolve(clinicSrc,f),'utf8')}));
  const bad=sources.flatMap(({file,source})=>routeScopeViolations(source).map(v=>file+' '+v));
  assert.deepEqual(bad,[],'Clinic routes declared outside the registry or without a resource: '+bad.join('; '));
  const elements=sources.reduce((n,{source})=>n+routeElements(source).length,0);
  assert.ok(elements>=21,'found the route elements of the registry ('+elements+')');
  assert.ok(!scanned.includes('http/billingApi.ts')&&existsSync(resolve(clinicSrc,'http/billingApi.ts')),'the billing API is left out on purpose');
  // negative fixtures
  const element=(rest,method='get',path='/x')=>`  { method: '${method}', path: '${path}', ${rest} },\n`,registry=(...entries)=>`export const routes = (u) => [\n${entries.join('')}];\n`;
  const scope=source=>routeScopeViolations(source);
  assert.deepEqual(scope(registry(element("resource: 'none', handler: async () => 1"),element("resource: 'appointment', handler: async () => 2",'patch','/x/:id'))),[],'a correct registry');
  assert.deepEqual(scope(registry(element("handler: async () => 1"))),['line 2: route get /x declares no resource'],'no resource');
  assert.deepEqual(scope(registry(element("resource: 'none', handler: async () => 1"),element('handler: async () => 2','post','/y'))),['line 3: route post /y declares no resource'],'only the second element lacks it');
  assert.deepEqual(scope(registry(element("handler: async () => ({ resource: 'none' })"))),['line 2: route get /x declares no resource'],'a resource inside the handler is not the declaration');
  assert.deepEqual(scope(registry(element("/* resource: 'none', */ handler: async () => 1"))),['line 2: route get /x declares no resource'],'a resource in a comment');
  assert.deepEqual(scope(registry(element("handler"))),['line 2: route get /x declares no resource'],'a shorthand handler without a resource');
  assert.deepEqual(scope("router.get('/x', handler);"),['line 1: router.get( declares a route outside the registry'],'router.get directly');
  for(const method of ['post','patch','put','delete','all'])assert.equal(scope(`router.${method}('/x', handler);`).length,1,'router.'+method);
  assert.equal(scope("router . get ('/x', handler);").length,1,'router.get with spaces');
  assert.deepEqual(scope("router.use(express.json({ limit: '8mb' }));\nrouter[route.method](route.path, pep(route, deps), route.handler);\n// router.get('/x', handler);\n/* router.post('/y', handler) */"),[],'router.use, router[method] and a comment are not declarations');
  assert.deepEqual(scope("export type ClinicRoute = {\n  method: 'get' | 'post' | 'patch' | 'delete';\n  path: string;\n  handler: express.RequestHandler;\n};"),[],'the type of an element is not an element');
  assert.deepEqual(scope("app.get('/health/live', (_req, res) => res.json({}));"),[],'app.get is not router.get');
  return elements+' route elements in '+scanned.length+' files, each with a resource; no router.get/post/patch/put/delete/all';
});

// ---- 12. Structure ratchet ---------------------------------------------------------------
// Each non-manual metric has a direction ("lower" or "higher" is better). Worse than the baseline fails; better passes
// and reminds to lower the baseline so the gain cannot be lost later. Manual metrics are declared, never compared.
const {measure,baselineOf,ciJobsRunning,LEGACY_APP,PRODUCTION_APP,walk,importEdges,importSpecifiers,clinicalSchema,clinicalReads,nestedTables,CLINICAL_MODELS,SCHEMA_PATH,DATA_DELEGATE,RAW_SQL,SQL_TABLE}=await import(pathToFileURL(resolve(root,'tools/phase2/arch-metrics.mjs')).href);
const RATCHET_FIX='node tools/phase2/arch-metrics.mjs --write-baseline';
export function ratchetFindings(current,baseline){
  const worse=[],better=[],stale=[];
  for(const [id,m] of Object.entries(current.metrics)){
    if(m.kind==='manual')continue;
    const base=baseline.metrics[id];
    if(!base||base.kind==='manual'){stale.push(id+': not in the baseline');continue;}
    if(base.better!==m.better)stale.push(id+': direction is '+m.better+' in the metric but '+base.better+' in the baseline');
    for(const [key,value] of Object.entries(m.values)){
      const was=base.values?.[key];
      if(typeof was!=='number'){stale.push(id+'.'+key+': not in the baseline');continue;}
      const delta=m.better==='lower'?value-was:was-value;
      if(delta>0)worse.push(id+'.'+key+' '+was+' -> '+value+' ('+m.better+' is better)');
      else if(delta<0)better.push(id+'.'+key+' '+was+' -> '+value);
    }
    for(const key of Object.keys(base.values??{}))if(!(key in m.values))stale.push(id+'.'+key+': in the baseline but no longer measured');
  }
  for(const id of Object.keys(baseline.metrics))if(!(id in current.metrics))stale.push(id+': in the baseline but no longer measured');
  return {worse,better,stale};
}
rule('structure-ratchet',()=>{
  const current=measure(root),baseline=JSON.parse(read('tools/phase2/arch-baseline.json')),{worse,better,stale}=ratchetFindings(current,baseline);
  assert.deepEqual(worse,[],'structure got worse than tools/phase2/arch-baseline.json: '+worse.join('; '));
  assert.deepEqual(stale,[],'baseline out of step with the metrics (run '+RATCHET_FIX+'): '+stale.join('; '));
  // negative fixtures
  const fx=(better,values)=>({metrics:{S:{kind:'measured',better,values}}});
  assert.deepEqual(ratchetFindings(fx('lower',{n:5}),fx('lower',{n:4})).worse,['S.n 4 -> 5 (lower is better)']);
  assert.deepEqual(ratchetFindings(fx('higher',{n:3}),fx('higher',{n:4})).worse,['S.n 4 -> 3 (higher is better)']);
  assert.deepEqual(ratchetFindings(fx('lower',{n:3}),fx('lower',{n:4})),{worse:[],better:['S.n 4 -> 3'],stale:[]});
  assert.deepEqual(ratchetFindings(fx('higher',{n:5}),fx('higher',{n:4})).better,['S.n 4 -> 5']);
  assert.deepEqual(ratchetFindings(fx('lower',{n:4}),fx('lower',{n:4})),{worse:[],better:[],stale:[]});
  assert.equal(ratchetFindings(fx('lower',{n:4,m:1}),fx('lower',{n:4})).stale.length,1,'a new value needs a baseline');
  assert.equal(ratchetFindings(fx('lower',{n:4}),fx('lower',{n:4,m:1})).stale.length,1,'a dropped value leaves the baseline stale');
  assert.equal(ratchetFindings({metrics:{}},fx('lower',{n:4})).stale.length,1,'a dropped metric leaves the baseline stale');
  assert.equal(ratchetFindings(fx('lower',{n:4}),{metrics:{}}).stale.length,1,'a new metric needs a baseline');
  assert.equal(ratchetFindings(fx('lower',{n:4}),fx('higher',{n:4})).stale.length,1,'the direction cannot be flipped in the baseline alone');
  assert.deepEqual(ratchetFindings({metrics:{S:{kind:'manual',declared:{x:2}}}},{metrics:{S:{kind:'manual',declared:{x:1}}}}),{worse:[],better:[],stale:[]});
  // S17 reads the workflow: only an uncommented run step in a job counts, and only that exact command
  const workflow=(...steps)=>'name: x\non: push\njobs:\n  proof:\n    steps:\n      - run: npm test\n  compose:\n    steps:\n'+steps.map(s=>'      '+s).join('\n')+'\n';
  assert.deepEqual(ciJobsRunning(workflow('- run: npm ci','- run: npm run test:docker:ingress'),'npm run test:docker:ingress'),['compose']);
  assert.deepEqual(ciJobsRunning(workflow('# - run: npm run test:docker:ingress'),'npm run test:docker:ingress'),[],'a commented step is not a run');
  assert.deepEqual(ciJobsRunning(workflow('- run: npm run test:docker:ingress-other'),'npm run test:docker:ingress'),[],'another script is not this one');
  assert.deepEqual(ciJobsRunning(workflow('- run: npm run test:docker:ingress').replace(/\n/g,'\r\n'),'npm run test:docker:ingress'),['compose'],'CRLF checkouts are read the same');
  // S5 sees a dynamic import of the monolith's app and of the production composition as well as a static one
  assert.ok(LEGACY_APP.test("const {createApp}=await import('../../backend/dist/src/legacy/app.js');")&&LEGACY_APP.test("import { createApp } from '../src/legacy/app.js';"));
  assert.ok(LEGACY_APP.test("const {createApp}=await import('../../backend/dist/src/app.js');"),'the pre-K4 path still counts');
  assert.ok(!LEGACY_APP.test("const {createApp}=await import('../../services/clinic/dist/app.js');"),'a service app is not the monolith');
  assert.ok(PRODUCTION_APP.test("const {createCoreApp}=await import('../../backend/dist/src/composition/coreApp.js');")&&!PRODUCTION_APP.test("import('../../backend/dist/src/app.js')"));
  // the real measurement against a baseline made stricter by one: the baseline of the measurement itself with one value one lower,
  // so the result does not depend on how far the committed baseline lags behind the code (an improvement passes)
  assert.deepEqual(ratchetFindings(current,baselineOf(current)),{worse:[],better:[],stale:[]},'a baseline written from the measurement holds');
  const strict=structuredClone(baselineOf(current)),first=Object.values(strict.metrics).find(m=>m.kind!=='manual'&&m.better==='lower'&&Object.values(m.values).some(v=>v>0));
  const key=Object.keys(first.values).find(k=>first.values[k]>0);first.values[key]-=1;
  assert.equal(ratchetFindings(current,strict).worse.length,1,'a stricter baseline must fail');
  return Object.values(current.metrics).filter(m=>m.kind!=='manual').length+' metrics held'+(better.length?'; improved, lower the baseline ('+RATCHET_FIX+'): '+better.join(', '):'');
});

// ---- 16. Core module map (K3, K4) -------------------------------------------------------------
// tools/phase2/core-modules.json: the groups of backend/src (contexts, and the kernel, dto, read, legacy and platform groups that are
// not contexts). An import that crosses two groups is declared in `edges`, a table one group reads that another owns in `dataEdges`
// (the remaining ones are joins inside the one Core database); a declaration nothing uses any more fails. Free by kind: anything may
// import the kernel, platform (composition, workers, entries) imports every group and no other group imports it except legacy, read
// imports every group, routes import dto and dto imports the ports it maps. legacy (backend/src/legacy, the Phase 1 clinical stack)
// imports every context, dto, read and kernel without declaring it (its coupling to hotel, billing and identity is therefore not in
// `edges`, nor its reads of pet, bookingStatusEvent and invoice in `dataEdges`: the count of declared edges fell by this exemption, not
// by removing the coupling); it imports platform only in legacy/app.ts, which is a composition of the monolith. Only platform and legacy
// import legacy (declaring the edge does not allow it), and a table legacy owns (the clinical tables) is read by legacy alone (declaring
// a data edge does not allow it either). The rule legacy-isolated (17) reads the same facts from the code itself.
const GROUP_KINDS = ['context', 'kernel', 'dto', 'read', 'legacy', 'platform'];
const LEGACY_COMPOSITION = 'legacy/app.ts';
const inPattern = (path, pattern) => (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);
// A Prisma delegate (tx|client|db.<delegate>.<call>) and the table a raw SQL template names after FROM, JOIN, INTO, TRUNCATE or UPDATE
// (DATA_DELEGATE, RAW_SQL and SQL_TABLE are in arch-metrics.mjs, shared with the rule legacy-isolated), and, since K4 Q6, the tables a query
// reaches through relations nested in include, select, where, orderBy or _count (nestedTables in arch-metrics.mjs follows each relation
// field to the model it points at, from the Prisma schema, over the same queries the rule legacy-isolated reads). A table read that way is
// attributed like a delegate: `include: { pet: true }` in a hotel file is a read of pet.
const SCHEMA = clinicalSchema(read(SCHEMA_PATH));
export function tablesRead(source, schema = SCHEMA) {
  const code = withoutComments(source), names = new Set();
  for (const m of code.matchAll(DATA_DELEGATE)) names.add(m[1]);
  for (const sql of code.matchAll(RAW_SQL)) for (const m of sql[1].matchAll(SQL_TABLE)) names.add(m[1]);
  for (const name of nestedTables(source, schema, DATA_DELEGATE)) names.add(name);
  return names;
}
export function coreModuleFindings(config, modules, base = resolve(root, 'backend/src')) {
  const found = [], { groups, edges = [], tables = {}, dataEdges = [] } = config, kind = name => groups[name].kind;
  for (const [name, group] of Object.entries(groups)) if (!GROUP_KINDS.includes(group.kind)) found.push('group ' + name + ' has the unknown kind ' + group.kind);
  const groupOf = new Map();
  for (const { file } of modules) {
    const hit = Object.entries(groups).filter(([, g]) => g.files.some(p => inPattern(file.replace(/\.ts$/, ''), p))).map(([name]) => name);
    if (!hit.length) found.push(file + ' belongs to no group');
    else if (hit.length > 1) found.push(file + ' belongs to ' + hit.length + ' groups: ' + hit.join(', '));
    else groupOf.set(file, hit[0]);
  }
  const abs = f => resolve(base, f), known = new Set(modules.map(m => abs(m.file))), relOf = new Map(modules.map(m => [abs(m.file), m.file]));
  const free = (from, to, a, b) => kind(from) === 'platform' || kind(from) === 'legacy' || kind(to) === 'kernel' || kind(from) === 'read' || (kind(from) === 'dto' && b.startsWith('application/ports/')) || (kind(to) === 'dto' && /^routes\//.test(a));
  const real = new Map();
  for (const { file, source } of modules) {
    const from = groupOf.get(file);
    if (!from) continue;
    for (const target of importEdges(abs(file), source, known)) {
      const to = groupOf.get(relOf.get(target)), b = relOf.get(target);
      if (!to || to === from) continue;
      if (kind(to) === 'platform' && kind(from) !== 'platform' && file !== LEGACY_COMPOSITION) found.push(file + ' imports ' + b + ': only platform and ' + LEGACY_COMPOSITION + ' may import platform');
      else if (kind(to) === 'legacy' && kind(from) !== 'platform') found.push(file + ' imports ' + b + ': only platform and legacy may import legacy');
      else if (!free(from, to, file, b) && !real.has(from + ' -> ' + to)) real.set(from + ' -> ' + to, file + ' -> ' + b);
    }
  }
  const declared = new Map(edges.map(e => [e.from + ' -> ' + e.to, e]));
  for (const [key, e] of declared) if (!groups[e.from] || !groups[e.to]) found.push('edge ' + key + ' names a group that does not exist');
  for (const [key, e] of declared) if (groups[e.to]?.kind === 'legacy') found.push('edge ' + key + ' points into legacy: nothing declares an import of legacy');
  for (const [key, example] of real) if (!declared.has(key)) found.push(key + ' is not in edges (first import: ' + example + ')');
  for (const key of declared.keys()) if (!real.has(key)) found.push('edge ' + key + ' is declared but no file imports it any more');
  const owner = new Map(Object.entries(tables).flatMap(([group, names]) => names.map(name => [name, group])));
  const realData = new Map();
  for (const { file, source } of modules) {
    const from = groupOf.get(file);
    if (!from) continue;
    for (const name of tablesRead(source)) {
      const to = owner.get(name);
      if (!to) { if (kind(from) !== 'platform') found.push(file + ' reads ' + name + ', which no group owns in tables'); }
      else if (kind(to) === 'legacy' && kind(from) !== 'legacy') found.push(file + ' reads ' + name + ', a table legacy owns: only legacy reads it');
      else if (kind(from) !== 'platform' && kind(from) !== 'legacy' && to !== from && kind(to) !== 'kernel' && kind(from) !== 'read' && kind(from) !== 'dto' && !realData.has(from + ' -> ' + to)) realData.set(from + ' -> ' + to, file + ' reads ' + name);
    }
  }
  const declaredData = new Set(dataEdges.map(e => e.from + ' -> ' + e.to));
  for (const e of dataEdges) if (groups[e.to]?.kind === 'legacy') found.push('data edge ' + e.from + ' -> ' + e.to + ' points into legacy: nothing declares a read of a legacy table');
  for (const [key, example] of realData) if (!declaredData.has(key)) found.push('data edge ' + key + ' is not in dataEdges (first: ' + example + ')');
  for (const key of declaredData) if (!realData.has(key)) found.push('data edge ' + key + ' is declared but no file reads it any more');
  return found;
}
rule('core-module-map', () => {
  const base = resolve(root, 'backend/src'), config = JSON.parse(read('tools/phase2/core-modules.json'));
  const modules = walk(base).map(f => ({ file: relative(base, f).split(sep).join('/'), source: readFileSync(f, 'utf8') }));
  assert.ok(modules.length >= 100, 'found the Core modules (' + modules.length + ')');
  const bad = coreModuleFindings(config, modules);
  assert.deepEqual(bad, [], 'Core module map (tools/phase2/core-modules.json): ' + bad.join('; '));
  // negative fixtures, one reason each (virtual files with the real group names; edges and dataEdges start empty)
  const edge = (from, to) => ({ from, to }), at = (sources, extra = {}) => coreModuleFindings({ ...config, edges: [], dataEdges: [], ...extra }, sources.map(([file, source]) => ({ file, source })));
  const hotel = 'application/services/hotelBookings.ts', billing = 'application/services/invoices.ts', hotelToBilling = ['hotel -> billing is not in edges (first import: ' + hotel + ' -> ' + billing + ')'];
  const target = [billing, 'export const a = 1;'], hotelRepo = 'infrastructure/persistence/hotelRepository.ts';
  assert.deepEqual(at([['application/services/stray.ts', '']]), ['application/services/stray.ts belongs to no group'], 'a file in no group');
  assert.deepEqual(at([['lib/token.ts', '']], { groups: { ...config.groups, extra: { kind: 'context', files: ['lib/token'] } } }), ['lib/token.ts belongs to 2 groups: identity, extra'], 'a file in two groups');
  assert.deepEqual(at([[hotel, "import { a } from './invoices.js';"], target]), hotelToBilling, 'a new edge hotel -> billing');
  assert.deepEqual(at([[hotel, "import { a } from './invoices.js';"], target], { edges: [edge('hotel', 'billing')] }), [], 'the same edge once declared');
  assert.deepEqual(at([], { edges: [edge('rescue', 'billing')] }), ['edge rescue -> billing is declared but no file imports it any more'], 'a declared edge that is gone');
  assert.deepEqual(at([], { edges: [edge('rescue', 'nowhere')] }).slice(0, 1), ['edge rescue -> nowhere names a group that does not exist'], 'a declared edge to a group that is not there');
  const toPlatform = [['application/services/pets.ts', "import { a } from '../../composition/http.js';"], ['composition/http.ts', '']];
  assert.deepEqual(at(toPlatform), ['application/services/pets.ts imports composition/http.ts: only platform and legacy/app.ts may import platform'], 'a context imports platform');
  assert.ok(at(toPlatform, { edges: [edge('directory', 'platform')] }).includes('application/services/pets.ts imports composition/http.ts: only platform and legacy/app.ts may import platform'), 'declaring the edge does not allow it');
  for (const statement of ["const a = await import('./invoices.js');", "export * from './invoices.js';", "export { a } from './invoices.js';", "export type { A } from './invoices.js';", "import type { A } from './invoices.js';", "import './invoices.js';"])
    assert.deepEqual(at([[hotel, statement], target]), hotelToBilling, statement);
  assert.deepEqual(at([[hotel, "// import { a } from './invoices.js';\n/* export * from './invoices.js'; */\nconst text = \"import('./invoices.js')\";"], target]), [], 'a comment or a string is not an import');
  assert.deepEqual(at([['application/services/pets.ts', "import { a } from './lists.js';"], ['application/services/lists.ts', '']]), ['directory -> read is not in edges (first import: application/services/pets.ts -> application/services/lists.ts)'], 'a context imports read');
  assert.deepEqual(at([['application/services/pets.ts', "import { a } from '../../domain/error.js';"], ['domain/error.ts', '']]), [], 'every group imports the kernel');
  assert.deepEqual(at([['composition/x.ts', "import { a } from '../application/services/invoices.js'; import { b } from '../routes/lists.js';"], target, ['routes/lists.ts', '']]), [], 'platform imports every group');
  assert.deepEqual(at([['application/services/lists.ts', "import { a } from './invoices.js';"], target]), [], 'read imports every group');
  assert.deepEqual(at([['routes/pets.ts', "import { a } from './dto/serialize.js';"], ['routes/dto/serialize.ts', "import type { A } from '../../application/ports/invoices.js';"], ['application/ports/invoices.ts', '']]), [], 'routes import dto and dto imports the ports it maps');
  assert.deepEqual(at([['application/services/pets.ts', "import { a } from '../../routes/dto/serialize.js';"], ['routes/dto/serialize.ts', '']]), ['directory -> dto is not in edges (first import: application/services/pets.ts -> routes/dto/serialize.ts)'], 'only routes import dto');
  assert.deepEqual(at([['routes/dto/serialize.ts', "import { a } from '../../application/services/invoices.js';"], target]), ['dto -> billing is not in edges (first import: routes/dto/serialize.ts -> application/services/invoices.ts)'], 'dto imports ports, not services');
  const dataEdge = (statement, extra) => at([[hotelRepo, statement]], extra), hotelData = ['data edge hotel -> billing is not in dataEdges (first: ' + hotelRepo + ' reads invoice)'];
  assert.deepEqual(dataEdge('await tx.invoice.findUnique({ where: { id } });'), hotelData, 'a delegate of another context');
  assert.deepEqual(dataEdge('await this.client.invoice.count();'), hotelData, 'this.client.<delegate>');
  assert.deepEqual(dataEdge('await db.invoice.update({});'), hotelData, 'db.<delegate>');
  assert.deepEqual(dataEdge('await tx.invoice.findUnique({});', { dataEdges: [edge('hotel', 'billing')] }), [], 'the same data edge once declared');
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;'), [hotelData[0].replace('reads invoice', 'reads invoices')], 'a raw SQL table of another context');
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM runtime.invoices WHERE id = ${id}`;'), [hotelData[0].replace('reads invoice', 'reads invoices')], 'a schema prefix is not the table');
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM "public"."hotel_bookings" WHERE id = ${id}`;'), [], 'a quoted schema prefix, a table of its own');
  assert.deepEqual(dataEdge('await tx\n  .invoice.findUnique({});'), hotelData, 'a delegate call broken over lines');
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;'), [], 'a raw SQL table of its own, FOR UPDATE is not a table');
  assert.deepEqual(dataEdge('await tx.hotelBooking.update({}); await tx.outboxEvent.create({});'), [], 'its own table and a kernel table');
  assert.deepEqual(dataEdge('// await tx.invoice.findUnique({});'), [], 'a comment reads nothing');
  assert.deepEqual(dataEdge('await tx.mystery.findMany({});'), [hotelRepo + ' reads mystery, which no group owns in tables'], 'a delegate no group owns');
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM mystery_table`;'), [hotelRepo + ' reads mystery_table, which no group owns in tables'], 'a raw SQL table no group owns');
  assert.deepEqual(dataEdge('', { dataEdges: [edge('hotel', 'billing')] }), ['data edge hotel -> billing is declared but no file reads it any more'], 'a declared data edge that is gone');
  assert.deepEqual(at([['infrastructure/persistence/listsRepository.ts', 'await tx.invoice.findMany({});'], ['composition/coreRoutes.ts', 'await db.user.findUnique({});']]), [], 'read and platform read any table');
  // relations nested in a query (K4 Q6): the table a relation points at is read, found by following each relation field to its model
  const nested = (statement, extra) => dataEdge(statement, extra), hotelReads = table => 'data edge hotel -> ' + { invoice: 'billing', user: 'identity', pet: 'directory' }[table] + ' is not in dataEdges (first: ' + hotelRepo + ' reads ' + table + ')';
  const asTable = statement => [...nestedTables(statement, SCHEMA)].sort();
  assert.deepEqual(asTable('await tx.hotelBooking.findMany({ include: { pet: true } });'), ['pet'], 'include one relation: the table it points at (the delegate itself is not in the result)');
  assert.deepEqual(asTable('await tx.dailyCareNote.findMany({ where: { booking: { owner: { id } } } });'), ['hotelBooking', 'user'], 'a where over two relations reads both tables, the second one by the model of the first');
  assert.deepEqual(asTable('await tx.user.findMany({ include: { _count: { select: { pets: true } } } });'), ['pet'], '_count: { select: { pets } } reads pet');
  assert.deepEqual(asTable('await tx.hotelBooking.findMany({ where: { items: {} }, select: { id: true } });'), [], 'items is a relation of Invoice, not of HotelBooking');
  assert.deepEqual(asTable('const w = { pet: { name } }; res.json({ owner: 1 });'), [], 'an object that is no query reads nothing');
  assert.deepEqual(nested('await tx.hotelBooking.findMany({ include: { invoices: true } });'), [hotelReads('invoice')], 'include a relation of another context that is not declared');
  assert.deepEqual(nested('await tx.hotelBooking.findMany({ include: { invoices: true } });', { dataEdges: [edge('hotel', 'billing')] }), [], 'the same relation once declared');
  assert.deepEqual(nested('await tx.hotelBooking.findMany({ include: { dailyCareNotes: { select: { id: true } } } });'), [], 'include a relation inside the same context');
  assert.deepEqual(nested('await tx.dailyCareNote.findMany({ where: { booking: { owner: { id } } } });'), [hotelReads('user')], 'a where over two relations: the table of the second level');
  assert.deepEqual(nested('await tx.dailyCareNote.findMany({ where: { booking: { invoices: { some: {} } } } });'), [hotelReads('invoice')], 'a where over two relations, the second one in another context');
  assert.deepEqual(nested('await tx.hotelBooking.findMany({ where: { items: {} } });'), [], 'a key that is a relation of another model is not a relation here');
  assert.deepEqual(dataEdge('await tx.user.findMany({ include: { _count: { select: { pets: true } } } });'), [hotelReads('user'), hotelReads('pet')], 'hotel reads user, and pet through _count');
  assert.deepEqual(asTable('await tx.hotelBooking.findMany({ include: { pet } });'), ['pet'], 'a relation as a shorthand property');
  assert.deepEqual(asTable('await tx.hotelBooking.findMany({ where: { id: { in: [a, pet, b] } } });'), [], 'commas inside a scalar value split no entry: `pet` there is a variable');
  assert.deepEqual(asTable('await tx.dailyCareNote.findMany({ where: { id: { in: [a, b] }, owner: { id } } });'), [], 'owner is no relation of dailyCareNote, whatever precedes it');
  assert.deepEqual(asTable('await tx.hotelBooking.findMany({ where: { id: { in: [a, b] }, owner: { id } } });'), ['user'], 'a relation key that follows a scalar value with commas and depth');
  assert.deepEqual(asTable('await tx.appointmentBillingOperation.create({ data: { payload: { invoice: "x" } } });'), [], 'a Json column holds data: a key named like a relation under it is not a read');
  assert.deepEqual(asTable('await tx.invoice.findMany({ where: { id: { in: rows.map(({ owner }) => owner) } } });'), [], 'a list of values under a scalar field is not walked');
  assert.deepEqual(asTable('await this.client.pet.findUnique({ where: { id } }).owner();'), ['user'], 'the fluent API: .owner() reads user');
  assert.deepEqual(asTable('await tx.pet.findUnique({ where: { id } })\n  .owner()\n  .invoices({ include: { items: true } });'), ['invoice', 'invoiceItem', 'user'], 'a fluent chain follows each relation to its model, and the arguments of each step');
  assert.deepEqual(asTable('await tx.pet.findUnique({ where: { id } }).name();'), [], 'a call after the query that is no relation reads nothing');
  assert.deepEqual(at([['infrastructure/persistence/publicRescueRepository.ts', 'await this.client.pet.findFirst({ where: { id } }).owner();']]), ['data edge rescue -> directory is not in dataEdges (first: infrastructure/persistence/publicRescueRepository.ts reads pet)', 'data edge rescue -> identity is not in dataEdges (first: infrastructure/persistence/publicRescueRepository.ts reads user)'], 'a rescue file reads user through .owner(), and pet through the delegate');
  assert.deepEqual(nested('await prisma.hotelBooking.findMany({ include: { pet: true } });'), [], 'the receivers are the ones the delegate reading takes (tx, client, db): prisma is read by neither, so the query is not counted by half');
  assert.deepEqual(asTable('await prisma.hotelBooking.findMany({ include: { pet: true } });'), ['pet'], 'nestedTables alone reads every receiver when it is not told otherwise');
  assert.deepEqual(nested('await this.db.hotelBooking.findMany({ include: { pet: true } });'), [hotelReads('pet')], 'db is a receiver of both readings');
  assert.deepEqual(at([['infrastructure/persistence/userRepository.ts', 'await tx.user.findMany({ include: { _count: { select: { pets: true } } } });']]), ['data edge identity -> directory is not in dataEdges (first: infrastructure/persistence/userRepository.ts reads pet)'], 'select _count: { select: { pets } } is a read of pet');
  assert.deepEqual(nested("const where: Prisma.HotelBookingWhereInput = { pet: { ownerId } };"), [hotelReads('pet')], 'a relation in an object declared with a Prisma type');
  assert.deepEqual(nested('await tx.hotelBooking.findMany({ where: { OR: [{ pet: { name } }, { id }] } });'), [hotelReads('pet')], 'a relation in an array');
  assert.deepEqual(nested('await tx.hotelBooking.findMany({ where: { ...(x ? { owner: { id } } : {}) } });'), [hotelReads('user')], 'a relation in a spread conditional');
  assert.deepEqual(nested('await tx.hotelBooking\n  .findMany({\n    include: { pet: true },\n  });'), [hotelReads('pet')], 'a call broken over lines');
  assert.deepEqual(nested('const d = { invoices: [] }; res.json({ pet: 1, owner: 2 });'), [], 'relation names outside a query read nothing');
  assert.ok(nested('await tx.pet.findMany({ include: { appointments: true } });').includes('infrastructure/persistence/hotelRepository.ts reads appointment, a table legacy owns: only legacy reads it'), 'a clinical table through a relation, outside legacy');
  assert.deepEqual(at([['legacy/infrastructure/persistence/x.ts', 'await tx.pet.findMany({ include: { appointments: true, owner: true } });']]), [], 'legacy reads any table through a relation');
  assert.deepEqual(at([['infrastructure/persistence/listsRepository.ts', 'await tx.user.findMany({ include: { invoices: true } });']]), [], 'read reads any table through a relation');
  assert.deepEqual(at([['composition/coreRoutes.ts', 'await db.user.findMany({ include: { pets: true } });']]), [], 'platform reads any table through a relation');
  // legacy (K4): the clinical stack imports every group and reads every table; only platform and legacy import it; only legacy reads its tables
  const legacyFile = 'legacy/routes/a.ts', toLegacy = (from, extra) => at([[from, "import { a } from '../../legacy/routes/a.js';"], [legacyFile, '']], extra);
  const importsLegacy = from => from + ' imports ' + legacyFile + ': only platform and legacy may import legacy';
  assert.deepEqual(toLegacy('application/services/pets.ts'), [importsLegacy('application/services/pets.ts')], 'a context imports legacy');
  assert.ok(toLegacy('application/services/pets.ts', { edges: [edge('directory', 'legacy')] }).includes(importsLegacy('application/services/pets.ts')), 'declaring the edge does not allow it');
  assert.ok(toLegacy('application/services/pets.ts', { edges: [edge('directory', 'legacy')] }).includes('edge directory -> legacy points into legacy: nothing declares an import of legacy'), 'a declared edge into legacy fails by itself');
  assert.deepEqual(toLegacy('application/services/lists.ts'), [importsLegacy('application/services/lists.ts')], 'read does not import legacy either');
  assert.deepEqual(toLegacy('routes/dto/serialize.ts'), [importsLegacy('routes/dto/serialize.ts')], 'dto does not import legacy');
  assert.deepEqual(toLegacy('composition/coreRoutes.ts'), [], 'platform imports legacy');
  assert.deepEqual(at([['legacy/application/services/x.ts', "import { a } from '../../../application/services/hotelBookings.js';"], [hotel, '']]), [], 'legacy imports a context');
  assert.deepEqual(at([['legacy/app.ts', "import { a } from '../composition/http.js';"], ['composition/http.ts', '']]), [], 'legacy/app.ts imports platform (it is a composition of the monolith)');
  assert.deepEqual(at([['legacy/routes/x.ts', "import { a } from '../../composition/http.js';"], ['composition/http.ts', '']]), ['legacy/routes/x.ts imports composition/http.ts: only platform and legacy/app.ts may import platform'], 'another legacy file does not import platform');
  assert.deepEqual(at([['legacy/index.ts', "import { a } from '../composition/http.js';"], ['composition/http.ts', '']]), ['legacy/index.ts imports composition/http.ts: only platform and legacy/app.ts may import platform'], 'not even legacy/index.ts');
  assert.deepEqual(at([['legacy/infrastructure/persistence/x.ts', 'await tx.appointment.findMany({}); await tx.invoice.findMany({}); await tx.$queryRaw`SELECT id FROM medical_records`;']]), [], 'legacy reads its tables and any other');
  const legacyData = (file, statement, extra) => at([[file, statement]], extra), legacyRead = (file, name) => file + ' reads ' + name + ', a table legacy owns: only legacy reads it';
  assert.deepEqual(legacyData(hotelRepo, 'await tx.appointment.findMany({});'), [legacyRead(hotelRepo, 'appointment')], 'a context reads a clinical table');
  assert.ok(legacyData(hotelRepo, 'await tx.appointment.findMany({});', { dataEdges: [edge('hotel', 'legacy')] }).includes(legacyRead(hotelRepo, 'appointment')), 'declaring the data edge does not allow it');
  assert.ok(legacyData(hotelRepo, '', { dataEdges: [edge('hotel', 'legacy')] }).includes('data edge hotel -> legacy points into legacy: nothing declares a read of a legacy table'), 'a declared data edge into legacy fails by itself');
  assert.deepEqual(legacyData(hotelRepo, 'await tx.$queryRaw`SELECT id FROM medical_records WHERE id = ${id} FOR UPDATE`;'), [legacyRead(hotelRepo, 'medical_records')], 'a raw SQL clinical table');
  assert.deepEqual(legacyData('infrastructure/persistence/listsRepository.ts', 'await tx.notification.count({});'), [legacyRead('infrastructure/persistence/listsRepository.ts', 'notification')], 'read reads a clinical table');
  assert.deepEqual(legacyData('composition/coreRoutes.ts', 'await db.medicalImage.findMany({});'), [legacyRead('composition/coreRoutes.ts', 'medicalImage')], 'platform reads a clinical table');
  return Object.keys(config.groups).length + ' groups, ' + config.edges.length + ' edges, ' + config.dataEdges.length + ' data edges, ' + modules.length + ' modules';
});

// ---- 17. Legacy isolation (K4) ----------------------------------------------------------------
// backend/src/legacy is the Phase 1 clinical stack, which split mode never runs. Outside it, a file fails when it:
//  1. imports, re-exports or `import()`s anything under legacy/ (composition/ is the one place that may);
//  2. calls a Prisma delegate of a clinical model (<receiver>.appointment|medicalRecord|medicalImage|notification.<find|create|update|...>),
//     with any receiver, not only tx, client and db;
//  3. names a clinical table in raw SQL (FROM, JOIN, INTO or UPDATE, with or without quotes);
//  4. holds a relation key to a clinical model (appointments, doctorAppts, medicalRecords, medicalImages, notifications, appointment: the
//     list is generated from backend/prisma/schema.prisma) in the arguments of a delegate call, or in an object declared with a Prisma
//     where/include/select/orderBy type (`: T = {`, `: T => ({`, `{ } satisfies T`, `{ } as T`);
//  5. uses a Prisma type of a clinical model (Prisma.AppointmentWhereInput) or imports one from @prisma/client (AppointmentStatus).
// The reader is clinicalReads in arch-metrics.mjs; S11 counts its findings as clinicalReadsOutsideLegacy, so the rule and the metric agree.
// Self-check: the reader must find at least 20 clinical reads inside legacy/, and the generated keys must hold appointments and doctorAppts,
// so a reader that went blind (a renamed delegate, a changed schema) fails here instead of passing everything.
// Known limits (code is read as text, not as a program; the full list is on clinicalReads in arch-metrics.mjs). Misses: a relation object
// put in a variable with no Prisma type and passed to a call later; a delegate reached through an alias (`const { appointment } = tx`) or
// `tx['appointment']`; `import { Prisma as P }` then `P.AppointmentWhereInput`; `$Enums.AppointmentStatus`, `Prisma.$Enums...`;
// `Prisma.validator<...>()({ appointments: true })`; `Prisma.PetGetPayload<{ include: { appointments: true } }>`; raw SQL built by
// concatenation, `FROM /*x*/ appointments`, `Prisma.raw('appointments')`; a table named only in a Prisma type outside the forms above
// (Prisma.UserFindManyArgs). Noise (a FAIL by mistake, fixed by renaming the variable): `this.cache.appointment.find(...)` is read as a
// Prisma delegate call. `this.rows.find(({ appointment }) => ...)`, `this.factory.create({ appointment })`, `unitOfWork.run(async ({
// bookings, notifications }) => ...)` and the `{ appointment: ... }` of coreRoutes are not read: relation keys count only in the arguments
// of a call on a model of the schema.
export function legacyViolations(file, source, schema) {
  if (file.startsWith('legacy/')) return [];
  const found = [];
  if (!file.startsWith('composition/'))
    for (const spec of importSpecifiers(source)) if (spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(file), spec)).startsWith('legacy/')) found.push(file + ' imports ' + spec + ': only composition/ may import legacy/');
  for (const r of clinicalReads(source, schema)) found.push(file + ':' + r.line + ' ' + r.kind + ' ' + r.text + ': a clinical table is read only inside legacy/');
  return found;
}
rule('legacy-isolated', () => {
  const base = resolve(root, 'backend/src'), schema = clinicalSchema(read(SCHEMA_PATH));
  const modules = walk(base).map(f => ({ file: relative(base, f).split(sep).join('/'), source: readFileSync(f, 'utf8') }));
  assert.ok(modules.length >= 100, 'found the Core modules (' + modules.length + ')');
  const bad = modules.flatMap(({ file, source }) => legacyViolations(file, source, schema));
  assert.deepEqual(bad, [], 'legacy is not isolated: ' + bad.join('; '));
  // self-check: the reader sees what it should
  const inLegacy = modules.filter(m => m.file.startsWith('legacy/')).reduce((n, m) => n + clinicalReads(m.source, schema).length, 0);
  assert.ok(inLegacy >= 20, 'the reader finds only ' + inLegacy + ' clinical reads inside legacy/ (at least 20 expected): it went blind');
  for (const key of ['appointments', 'doctorAppts']) assert.ok(schema.keys.has(key), 'the relation keys generated from the schema lack ' + key + ': ' + [...schema.keys].join(', '));
  assert.deepEqual([...schema.delegates].sort(), ['appointment', 'medicalImage', 'medicalRecord', 'notification'], 'the clinical delegates');
  assert.deepEqual([...schema.tables].sort(), ['appointments', 'medical_images', 'medical_records', 'notifications'], 'the clinical tables');
  assert.ok(CLINICAL_MODELS.every(m => schema.models.includes(m)), 'the clinical models are in the schema');
  // negative fixtures: each must fail (one reason each)
  const outside = 'infrastructure/persistence/x.ts', inside = 'legacy/infrastructure/persistence/x.ts', at = (file, source) => legacyViolations(file, source, schema);
  const fails = {
    'a delegate of a clinical model': 'await tx.appointment.findMany({});',
    'this.client.medicalRecord': 'await this.client.medicalRecord.count();',
    'db.notification.groupBy': "await db.notification.groupBy({ by: ['type'] });",
    'another receiver (prisma)': 'await prisma.medicalImage.create({ data });',
    'a generic delegate call': 'await tx.appointment.findMany<X>({});',
    'raw SQL, FROM': 'await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;',
    'raw SQL, quoted table': 'await tx.$queryRaw`SELECT * FROM "medical_images"`;',
    'raw SQL, JOIN': 'await tx.$queryRaw`SELECT 1 FROM pets p JOIN notifications n ON n.related_pet_id = p.id`;',
    'raw SQL, UPDATE': 'await tx.$executeRaw`UPDATE notifications SET status = ${s}`;',
    'raw SQL, unsafe string': "await tx.$queryRawUnsafe('SELECT * FROM medical_records');",
    'raw SQL, schema prefix': 'await tx.$queryRaw`SELECT * FROM runtime.appointments`;',
    'raw SQL, quoted schema prefix': 'await tx.$queryRaw`SELECT * FROM "public"."appointments"`;',
    'raw SQL, TRUNCATE': 'await tx.$executeRaw`TRUNCATE appointments`;',
    'raw SQL, TRUNCATE TABLE with a schema': 'await tx.$executeRaw`TRUNCATE TABLE public.notifications`;',
    'a chain Prettier broke over two lines': 'await tx.appointment\n  .findMany({});',
    'a space before the dot': 'await tx.appointment .findMany({});',
    'optional chaining': 'await tx?.appointment?.findMany({});',
    'an optional call': 'await tx.appointment.findMany?.({});',
    'a relation reached by the fluent API': 'await tx.pet.findUnique({ where: { id } }).appointments();',
    'the fluent API over two lines': 'await tx.pet.findUnique({ where: { id } })\n  .medicalRecords();',
    'a relation in an array of typed objects': "const o: Prisma.PetOrderByWithRelationInput[] = [{ id: 'asc' }, { appointments: { _count: 'asc' } }];",
    'a relation in include': 'await tx.pet.findMany({ include: { appointments: true } });',
    'a relation in a _count select': 'await tx.user.findMany({ include: { _count: { select: { notifications: true } } } });',
    'a relation in where': 'await tx.user.findMany({ where: { medicalRecords: { some: {} } } });',
    'the doctorAppts relation': 'await tx.user.count({ where: { doctorAppts: { none: {} } } });',
    'the appointment relation (singular)': 'await tx.invoice.findMany({ include: { appointment: true } });',
    'a relation as shorthand': 'await tx.pet.findMany({ select: { id: true, medicalImages } });',
    'a relation in an object typed Prisma.*WhereInput': 'const where: Prisma.PetWhereInput = { appointments: { some: {} } };',
    'a relation in an arrow returning Prisma.*WhereInput': 'const f = (): Prisma.UserWhereInput => ({ notifications: { some: {} } });',
    'a relation in an object satisfies Prisma.*Include': 'const include = { medicalRecords: true } satisfies Prisma.PetInclude;',
    'a relation in an object as Prisma.*Select': 'const select = { medicalImages: true } as Prisma.PetSelect;',
    'a name imported from @prisma/client': "import { type AppointmentStatus } from '@prisma/client';",
    'a model type imported from @prisma/client': "import { Prisma, MedicalRecord } from '@prisma/client';",
    'a type re-exported from @prisma/client': "export type { Notification } from '@prisma/client';",
    'a Prisma type of a clinical model': 'let w: Prisma.AppointmentWhereInput;',
  };
  for (const [reason, source] of Object.entries(fails)) assert.ok(at(outside, source).length > 0, 'must fail: ' + reason);
  const imports = {
    'a route imports a legacy route': ['routes/x.ts', "import { a } from '../legacy/routes/a.js';"],
    'a dynamic import': ['routes/x.ts', "const { a } = await import('../legacy/a.js');"],
    'a re-export of everything': ['routes/x.ts', "export * from '../legacy/a.js';"],
    'a named re-export': ['infrastructure/x.ts', "export { a } from '../legacy/a.js';"],
    'a type import': ['application/x.ts', "import type { A } from '../legacy/a.js';"],
    'a side-effect import': ['routes/x.ts', "import '../legacy/a.js';"],
    'a workers file': ['workers/x.ts', "import { a } from '../legacy/index.js';"],
    'the entry': ['index.ts', "import { a } from './legacy/index.js';"],
    'a file in composition/ is the only exception, one level down is not': ['routes/internal/x.ts', "import { a } from '../../legacy/a.js';"],
  };
  for (const [reason, [file, source]] of Object.entries(imports)) assert.equal(at(file, source).length, 1, 'must fail: ' + reason);
  assert.match(at(outside, 'await tx.appointment.findMany({});')[0], /^infrastructure\/persistence\/x\.ts:1 delegate appointment/, 'the finding names the file, the line and the read');
  // negative fixtures: each must pass
  const passes = {
    'a delegate of another model': 'await tx.invoice.findMany({ where: { appointmentId: id } });',
    'a billing model whose name starts with Appointment': 'await tx.appointmentBillingOperation.findMany({}); const w: Prisma.AppointmentBillingOperationWhereInput = {};',
    'raw SQL of the billing operation table': 'await tx.$queryRaw`SELECT id FROM "AppointmentBillingOperation" WHERE id = ${id} FOR UPDATE`;',
    'raw SQL of another table, FOR UPDATE is not a table': 'await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;',
    'raw SQL of another table with a schema prefix': 'await tx.$queryRaw`SELECT id FROM runtime.invoices`; await tx.$queryRaw`SELECT 1 FROM "public"."invoices"`;',
    'a variable that is not a delegate, destructured in a callback': 'const a = this.rows.find(({ appointment }) => appointment.id === id);',
    'a factory that is not a delegate': 'const b = this.factory.create({ appointment });',
    'the unit of work callback': 'return this.deps.unitOfWork.run(async ({ bookings, notifications }) => { return bookings; });',
    'a relation key outside a call and a typed object': 'const d = { appointments: [] };',
    'a response body that is not a delegate call': 'res.json({ appointments: [], notifications: [] });',
    'a clinical key in a typed object of another meaning': 'const e: Record<string, number> = { appointments: 1 };',
    'a Prisma type that is not clinical': "import { Role } from '@prisma/client'; let w: Prisma.UserWhereInput = { role: 'owner' };",
    'comments': '// await tx.appointment.findMany({});\n/* FROM appointments */\n/* include: { appointments: true } */',
    'strings': "const a = 'tx.appointment.findMany(';\nconst b = \"include: { appointments: true } FROM medical_records\";\nconst c = '../legacy/a.js';",
    'a template that is not raw SQL': 'const t = `SELECT * FROM appointments`;',
  };
  for (const [reason, source] of Object.entries(passes)) assert.deepEqual(at(outside, source), [], 'must pass: ' + reason);
  assert.deepEqual(at('routes/x.ts', "import { a } from './dto/a.js'; import { b } from '../legacy-notes.js';"), [], 'a path that only starts with the word legacy');
  assert.deepEqual(at('composition/coreRoutes.ts', "import { a } from '../legacy/index.js'; export * from '../legacy/a.js'; const { b } = await import('../legacy/b.js');"), [], 'composition imports legacy');
  assert.deepEqual(at('composition/coreRoutes.ts', 'await tx.appointment.findMany({});').length, 1, 'composition may import legacy but not read the tables');
  for (const source of [...Object.values(fails), 'await tx.medicalRecord.count({}); await tx.notification.groupBy({});']) assert.deepEqual(at(inside, source), [], 'inside legacy/ the same code passes');
  assert.deepEqual(at(inside, "import { a } from '../../../composition/a.js'; import { b } from './x.js';"), [], 'legacy imports whatever it needs');
  return modules.length + ' modules; ' + inLegacy + ' clinical reads inside legacy/, none outside; keys ' + [...schema.keys].sort().join(', ') + '; ' + (Object.keys(fails).length + Object.keys(imports).length + 1) + ' must-fail and ' + (Object.keys(passes).length + Object.keys(fails).length + 4) + ' must-pass fixtures';
});

// ---- 18. Gateway routes from one source (K5) ---------------------------------------------------
// Which service answers an /api path is declared once in packages/contracts/src/gatewayRoutes.ts. Every place that routes /api
// traffic (tools/phase2/gateway-routing.mjs ROUTING_PLACES, nine: the compose nginx, the split example, the measurement gateway in its two
// topologies (stack.mjs#direct and stack.mjs#core-ingress), the resilience gateway, the P7 rehearsal, the E2E proxy, the frontend client,
// the Vite dev proxy) must send a fixed set of probe paths where its topology says
// (core-ingress: all to Core; direct: each owned prefix to its owner), unless a listed exception with a reason and an end date says
// otherwise. A proxy_pass in a file that is not a place fails, and so does a place that reads as empty. The gateway and service
// OpenAPI files must agree on who owns each path, and Core's routes take the prefixes from the contracts.
const routingCheck=(existsSync(built)?import(pathToFileURL(built).href):Promise.reject(new Error('build packages/contracts first (npm run build -w @nipopeto/contracts)')))
  .then(contracts=>rule('gateway-routes-single-source',()=>{
    const real=realIo(root),today=new Date().toISOString().slice(0,10),FIXED='2026-11-06';
    const findings=routingFindings(contracts,today,real);
    assert.deepEqual(findings,[],'gateway routing differs from packages/contracts/src/gatewayRoutes.ts: '+findings.join('; '));
    // negative fixtures: each must fail (a finding starts with the tag), every edit must change the text it names
    const SPLIT='deploy/phase2/nginx.split.conf.example',TEMPLATE='frontend/nginx/default.conf.template',E2E='tools/phase2/e2e-server.mjs',CLIENT='frontend/src/services/apiClient.ts',
      STACK='benchmarks/phase2/kaggle/stack.mjs',ROUTES='backend/src/composition/coreRoutes.ts',APP='backend/src/composition/coreApp.ts',
      VITE='frontend/vite.config.ts',RES='tools/phase2/resilience.test.mjs',P7='tools/phase2/p7-rehearsal.test.mjs',BILLING='tools/phase2/billing.test.mjs',
      SOURCE='packages/contracts/src/gatewayRoutes.ts',CLINIC_SPEC='services/clinic/openapi.json',NOTIFICATION_SPEC='services/notification/openapi.json';
    const edit=(path,from,to)=>{const text=real.read(path);assert.ok(text.includes(from),'fixture edit not found in '+path+': '+from);return {[path]:text.replace(from,()=>to)};};
    const edits=(path,pairs)=>{let text=real.read(path);for(const [from,to] of pairs){assert.ok(text.includes(from),'fixture edit not found in '+path+': '+from);text=text.replace(from,()=>to);}return {[path]:text};};
    const append=(path,text)=>({[path]:real.read(path)+'\n'+text+'\n'});
    const json=(path,change)=>{const spec=JSON.parse(real.read(path));change(spec.paths);return {[path]:JSON.stringify(spec)};};
    const run=(files,{routes,exceptions,ignore,places,at=FIXED}={})=>{
      const c=routes?{...contracts,gatewayRoutes:routes,routeOwner:p=>routes.find(r=>p===r.prefix||p.startsWith(r.prefix+'/'))?.service??'core'}:contracts;
      return routingFindings(c,at,fixtureIo(real,files,{...(exceptions?{exceptions}:{}),...(ignore?{ignore}:{}),...(places?{places}:{})}),{dist:!routes});
    };
    const VACC='location ~ ^/api/vaccinations(/|$) { proxy_pass http://clinic; }';
    const CORE='location /api/ { proxy_pass http://core; }',CLINIC_LOCATION='location ~ ^/api/(appointments|medical-records|dashboard/clinic)(/|$) { proxy_pass http://clinic; }';
    const e2eBranch="if(path.startsWith('/api/')){",e2eForward='fetch(origins.core+req.url';
    const e2eDetour=(call)=>edit(E2E,e2eBranch,"if(path.startsWith('/api/appointments')){"+call+"res.writeHead(200);res.end();return;}\n    "+e2eBranch);
    const ghost=[...contracts.gatewayRoutes,{prefix:'/api/ghost',service:'clinic'}],nested=[...contracts.gatewayRoutes,{prefix:'/api/appointments/archive',service:'clinic'}];
    // The real lists hold no exception and no dated ignore (the K9 harness reads direct as the standard topology), so the checks on their dates, reasons and
    // staleness run on synthetic entries: SYN waives /api/dashboard/clinic for stack.mjs#direct once NO_DASHBOARD takes it out of that template (else it is
    // stale); SYN_IGNORE waives a file that only quotes a proxy, tools/stray-quote.py.
    const SYN={place:STACK+'#direct',prefix:'/api/dashboard/clinic',routesTo:'core',until:'2026-11-20',reason:'a synthetic exception for the fixtures'};
    const NO_DASHBOARD=edit(STACK,'(appointments|medical-records|dashboard/clinic)','(appointments|medical-records)');
    const SYN_IGNORE={file:'tools/stray-quote.py',reason:'a synthetic ignore entry for the fixtures',until:'2026-11-20'},STRAY_QUOTE={'tools/stray-quote.py':'# a proxy_pass http://core; that is only quoted here\n'};
    const DIRECT=STACK+'#direct';
    const fails=[
      ['direct config without dashboard/clinic',/^table deploy/,run(edit(SPLIT,'(appointments|medical-records|dashboard/clinic)','(appointments|medical-records)'))],
      ['direct config also sends vaccinations to Clinic',/^table deploy/,run(edit(SPLIT,'location /api/ { proxy_pass http://core; }','location ~ ^/api/vaccinations(/|$) { proxy_pass http://clinic; } location /api/ { proxy_pass http://core; }'))],
      ['core-ingress config with a Clinic regex',/^fail-closed frontend\/nginx.*not to Core/,run(edit(TEMPLATE,'location /api/ {','location ~ ^/api/appointments(/|$) { proxy_pass http://clinic; }\n    location /api/ {'))],
      ['~* sends /api/Appointments to Clinic',/^table deploy/,run(edit(SPLIT,'location ~ ^/api/(appointments','location ~* ^/api/(appointments'))],
      ['^~ /api/ stops the regexes',/^table deploy/,run(edit(SPLIT,'location /api/ {','location ^~ /api/ {'))],
      ['a regex with no segment boundary takes /api/appointmentsx',/^table deploy/,run(edit(SPLIT,'dashboard/clinic)(/|$)','dashboard/clinic)'))],
      ['a target that is no known service',/^table deploy/,run(edit(SPLIT,'proxy_pass http://notification','proxy_pass http://elsewhere'))],
      ['/api/pets does not go to Core',/^fail-closed deploy/,run(edit(SPLIT,'location /api/ { proxy_pass http://core; }','location /api/ { proxy_pass http://clinic; }'))],
      ['a server block with no location',/^fail-closed deploy/,run({[SPLIT]:'server { listen 127.0.0.1:8080; }'})],
      ['the listen address matches no server',/^fail-closed frontend\/nginx/,run({[TEMPLATE]:'server { listen 9999; location /api/ { proxy_pass http://api:${API_PORT}; } }'})],
      ['no nginx template in a JS file',/^fail-closed benchmarks/,run({[STACK]:'export const x = 1;'})],
      ['the E2E proxy forwards to Clinic',/^fail-closed tools\/phase2\/e2e/,run(edit(E2E,'fetch(origins.core+req.url','fetch(origins.clinic+req.url'))],
      ['the E2E proxy forwards to a computed origin',/^fail-closed tools\/phase2\/e2e/,run(edit(E2E,'fetch(origins.core+req.url','fetch(origins[pick(req)]+req.url'))],
      ['a second frontend variable VITE_CLINIC_URL',/^fail-closed frontend\/src/,run(append(CLIENT,'const c = import.meta.env.VITE_CLINIC_URL;'))],
      ['the frontend names a service port',/^fail-closed frontend\/src/,run(append(CLIENT,"const d = 'http://localhost:5101/api';"))],
      ['the frontend names a service prefix',/^fail-closed frontend\/src/,run(append(CLIENT,"const p = '/api/appointments';"))],
      ['a second fetch in the frontend',/^fail-closed frontend\/src/,run(append(CLIENT,"await fetch('/x');"))],
      ['the Clinic spec lists /api/vaccinations',/^openapi \(b\)/,run(json(CLINIC_SPEC,p=>{p['/api/vaccinations']={get:{}};}))],
      ['a Clinic path of the gateway is missing from the Clinic spec',/^openapi \(a\)/,run(json(CLINIC_SPEC,p=>{delete p['/api/appointments/availability'];}))],
      ['a method of the gateway is missing from the Clinic spec',/^openapi \(a\).*methods differ/,run(json(CLINIC_SPEC,p=>{delete p['/api/appointments'].post;}))],
      ['the Notification spec lists a path of the Clinic prefix',/^openapi \(b\)/,run(json(NOTIFICATION_SPEC,p=>{p['/api/appointments/zz']={get:{}};}))],
      ['a prefix that covers no path',/^openapi \(c\) prefix \/api\/ghost covers/,run({},{routes:ghost})],
      ['one prefix inside another',/^openapi \(c\).* is a prefix of /,run({},{routes:nested})],
      ['a literal prefix in an app.use of coreRoutes',/^literal .*coreRoutes/,run(append(ROUTES,"app.use('/api/appointments', express.json(), handler);"))],
      ['a literal prefix list in coreRoutes',/^literal .*coreRoutes/,run(append(ROUTES,"const p = { prefixes: ['/api/notifications'] };"))],
      ['a literal prefix in coreApp',/^literal .*coreApp/,run(append(APP,"const p = '/api/medical-records';"))],
      ['coreRoutes no longer imports the contracts',/^literal .*does not take/,run(edit(ROUTES,"from '@nipopeto/contracts'","from './nope.js'"))],
      ['the built contracts are older than the source',/^dist/,run(edit(SOURCE,"'/api/medical-records'","'/api/medical-record'"))],
      ['an exception past its date',/^exception .*expired/,run(NO_DASHBOARD,{exceptions:[SYN],at:'2026-11-21'})],
      ['an exception that no longer differs',/^exception .*stale/,run(NO_DASHBOARD,{exceptions:[SYN,{place:SPLIT,prefix:'/api/dashboard/clinic',routesTo:'core',until:'2027-01-01',reason:'a reason of some length'}]})],
      ['an exception that is still listed after the place was fixed',/^exception .*stale/,run({},{exceptions:[SYN]})],
      ['an exception with no reason',/^exception .*no reason/,run(NO_DASHBOARD,{exceptions:[{...SYN,reason:''}]})],
      ['an exception for a place that is not listed',/^exception .*place not found/,run(NO_DASHBOARD,{exceptions:[SYN,{...SYN,place:'tools/phase2/nowhere.mjs'}]})],
      ['an exception to a service the place does not use',/^table benchmarks/,run(NO_DASHBOARD,{exceptions:[{...SYN,routesTo:'notification'}]})],
      ['a proxy_pass in a file that is not a place',/^sweep tools\/stray\.conf/,run({'tools/stray.conf':'server { location /api/ { proxy_pass http://core; } }'})],
      // nginx text: read the way nginx reads it, or refuse
      ['a regex with no space after ~',/^table deploy/,run(edit(SPLIT,CORE,'location ~^/api/vaccinations(/|$) { proxy_pass http://clinic; } '+CORE))],
      ['a ~* regex with no space after it',/^table deploy/,run(edit(SPLIT,CORE,'location ~*^/api/appointments(/|$) { proxy_pass http://clinic; } '+CORE))],
      ['= with no space sends /api/pets to Clinic',/^fail-closed deploy.*\/api\/pets goes to clinic/,run(edit(SPLIT,CORE,'location =/api/pets { proxy_pass http://clinic; } '+CORE))],
      ['a quoted regex',/^table deploy/,run(edit(SPLIT,CORE,'location ~ "^/api/vaccinations(/|$)" { proxy_pass http://clinic; } '+CORE))],
      ['a quoted prefix',/^table deploy/,run(edit(SPLIT,CORE,'location "/api/vaccinations" { proxy_pass http://clinic; } '+CORE))],
      ['a location nested in the /api/ location',/^fail-closed frontend\/nginx.*nested location/,run(edit(TEMPLATE,'proxy_pass http://api:${API_PORT};','proxy_pass http://api:${API_PORT};\n        location ~ ^/api/appointments { proxy_pass http://clinic-api:5101; }'))],
      ['a proxy_pass inside an if',/^fail-closed frontend\/nginx.*proxy_pass in an if/,run(edit(TEMPLATE,'proxy_pass http://api:${API_PORT};','proxy_pass http://api:${API_PORT};\n        if ($uri ~ ^/api/appointments) { proxy_pass http://clinic-api:5101; }'))],
      ['a redirect inside an if',/^fail-closed frontend\/nginx.*return redirect in an if/,run(edit(TEMPLATE,'proxy_pass http://api:${API_PORT};','proxy_pass http://api:${API_PORT};\n        if ($uri ~ ^/api/appointments) { return 307 http://clinic-api:5101; }'))],
      ['a rewrite',/^fail-closed frontend\/nginx.*rewrite in the gateway server/,run(edit(TEMPLATE,'location /api/ {','location /clinic/ { proxy_pass http://clinic-api:5101/api/; }\n    location /api/ {\n        rewrite ^/api/appointments(.*)$ /clinic/appointments$1 last;'))],
      ['an include',/^fail-closed frontend\/nginx.*include/,run(edit(TEMPLATE,'location /api/ {','include /etc/nginx/extra/*.conf;\n    location /api/ {'))],
      ['an error_page to a named location',/^fail-closed deploy.*error_page jumps to @clinic/,run(edit(SPLIT,CORE,'location /api/ { proxy_pass http://core; error_page 404 = @clinic; }'))],
      ['a named location',/^fail-closed deploy.*named location/,run(edit(SPLIT,CORE,'location @clinic { proxy_pass http://clinic; } '+CORE))],
      ['a try_files that falls back to a named location',/^fail-closed frontend\/nginx.*try_files falls back to the named location @clinic/,run(edit(TEMPLATE,'try_files $uri =404;','try_files $uri @clinic;'))],
      ['a second server on port 8080 with default_server',/^fail-closed frontend\/nginx.*2 server blocks listen on 8080/,run(append(TEMPLATE,'server { listen 8080 default_server; location /api/ { proxy_pass http://clinic-api:5101; } }'))],
      ['a second server on [::]:8080',/^fail-closed frontend\/nginx.*2 server blocks listen on 8080/,run(append(TEMPLATE,'server { listen [::]:8080; location /api/ { proxy_pass http://clinic-api:5101; } }'))],
      ['a second server on 127.0.0.1:8080 with default_server',/^fail-closed deploy.*2 server blocks listen on 8080/,run(edit(SPLIT,'    # Core CLINIC_SERVICE_URL','    server { listen 127.0.0.1:8080 default_server; location / { proxy_pass http://clinic; } }\n    # Core CLINIC_SERVICE_URL'))],
      ['a ${…} that hides a location in the gateway server',/^fail-closed benchmarks.*does not list/,run(edit(STACK,'location /api/ { ${coreGateway}','${extraLocations} location /api/ { ${coreGateway}'))],
      ['a ${…} that hides a location in the core-ingress gateway server',/^fail-closed benchmarks.*#core-ingress.*does not list/,run(edit(STACK,'return 404; } location /api/ { ${coreGateway}','return 404; } ${extraLocations} location /api/ { ${coreGateway}'))],
      ['a proxy_pass target taken from a ${…}',/^fail-closed benchmarks.*does not list/,run(edit(STACK,'location /api/ { ${coreGateway} proxy_pass http://core;','location /api/ { ${coreGateway} proxy_pass ${pickUpstream};'))],
      ['the P7 maintenance conditional is no longer the listed text',/^fail-closed tools\/phase2\/p7.*does not list/,run(edit(P7,'^(GET|HEAD|OPTIONS)$','^(GET|HEAD)$'))],
      ['a ${…} the resilience gateway does not list',/^fail-closed tools\/phase2\/resilience.*does not list/,run(edit(RES,'listen 127.0.0.1:${edge};','listen 127.0.0.1:${edge}; ${extra}'))],
      // the sweep
      ['a proxy_pass in a directory named evidence that is not the frozen one',/^sweep tools\/evidence\/stray\.conf/,run({'tools/evidence/stray.conf':'server { location /api/ { proxy_pass http://core; } }'})],
      ['a Vite proxy in a file that is not a place',/^sweep tools\/other\.config\.ts/,run({'tools/other.config.ts':'export default { server: { proxy: { "/api": "http://localhost:5101" } } };'})],
      ['createProxyMiddleware in a file that is not a place',/^sweep tools\/mw\.mjs/,run({'tools/mw.mjs':"import { createProxyMiddleware } from 'http-proxy-middleware';"})],
      ['a fetch of the request URL in a file that is not a place',/^sweep tools\/relay\.mjs/,run({'tools/relay.mjs':'const r = await fetch(base + req.url);'})],
      ['the billing stand-in is a proxy that only its ignore entry lets through',/^sweep tools\/phase2\/billing\.test\.mjs/,run({},{ignore:real.ignore.filter(e=>e.file!==BILLING)})],
      ['a sweep ignore past its date',/^sweep ignore .*expired/,run(STRAY_QUOTE,{ignore:[...real.ignore,SYN_IGNORE],at:'2026-11-21'})],
      ['a sweep ignore for a file with no proxy',/^sweep ignore tools\/phase2\/arch-check\.mjs: stale/,run({},{ignore:[...real.ignore,{file:'tools/phase2/arch-check.mjs',reason:'a reason that is long enough'}]})],
      ['a sweep ignore with no reason',/^sweep ignore .*no reason/,run({},{ignore:real.ignore.map(e=>e.file===BILLING?{...e,reason:''}:e)})],
      ['a sweep ignore with a date too far ahead',/^sweep ignore .*more than 60 days/,run(STRAY_QUOTE,{ignore:[...real.ignore,{...SYN_IGNORE,until:'2027-06-01'}]})],
      ['a sweep ignore with a date that does not exist',/^sweep ignore .*until is not a date/,run(STRAY_QUOTE,{ignore:[...real.ignore,{...SYN_IGNORE,until:'2026-02-30'}]})],
      // the E2E proxy
      ['a template-literal fetch to Clinic in a branch before /api/',/^fail-closed tools\/phase2\/e2e.*outside the \/api\/ branch that is not the readiness probe/,run(e2eDetour('const r=await fetch(`${origins.clinic}${req.url}`);'))],
      ['a fetch through another variable in a branch before /api/',/^fail-closed tools\/phase2\/e2e.*outside the \/api\/ branch that is not the readiness probe/,run(e2eDetour('const base=origins.clinic;const r=await fetch(base+req.url);'))],
      ['a second fetch inside the /api/ branch',/^fail-closed tools\/phase2\/e2e.*must hold exactly one fetch/,run(edit(E2E,'const r=await fetch(origins.core+req.url','await fetch(origins.clinic+"/x");const r=await fetch(origins.core+req.url'))],
      ['req.url copied into a variable',/^fail-closed tools\/phase2\/e2e.*req\.url is used outside/,run(edit(E2E,"const path=new URL(req.url,'http://127.0.0.1').pathname;","const path=new URL(req.url,'http://127.0.0.1').pathname;const raw=req.url;"))],
      // the frontend
      ['a second origin variable VITE_CLINIC_ORIGIN',/^fail-closed frontend\/src.*VITE_API_BASE_URL is the one origin variable/,run(edit(CLIENT,'const response = await fetch(`${API_BASE_URL}','const base = endpoint.startsWith("/appointments") ? import.meta.env.VITE_CLINIC_ORIGIN : API_BASE_URL;\n  const response = await fetch(`${base}'))],
      ['a Clinic host written in the client',/^fail-closed frontend\/src.*names a second origin/,run(edit(CLIENT,'const response = await fetch(`${API_BASE_URL}','const base = endpoint.startsWith("/appointments") ? "http://clinic-api/api" : API_BASE_URL;\n  const response = await fetch(`${base}'))],
      ['a second origin in another literal of the client',/^fail-closed frontend\/src.*names a second origin/,run(append(CLIENT,"const other = 'https://other.example';"))],
      ['an /api URL in another frontend file',/^fail-closed frontend\/src.*names an \/api URL/,run({'frontend/src/other.ts':"export const u = 'https://svc.example/api/x';"})],
      ['window.fetch next to the client',/^fail-closed frontend\/src.*exactly one use of fetch/,run({'frontend/src/other.ts':'export const f = () => window.fetch("/x");'})],
      ['a WebSocket in the frontend',/^fail-closed frontend\/src.*another way to reach the network/,run({'frontend/src/other.ts':'export const w = new WebSocket("ws://x");'})],
      ['an API_BASE_URL with a literal that is not listed',/^fail-closed frontend\/src.*API_BASE_URL may name only/,run(edit(CLIENT,': "/api")',': "/api/v2")'))],
      ['a fetch that does not start from API_BASE_URL',/^fail-closed frontend\/src.*does not start from API_BASE_URL/,run(edit(CLIENT,'fetch(`${API_BASE_URL}','fetch(`${String(1)}'))],
      // the Vite dev proxy
      ['a second key in the Vite proxy',/^fail-closed frontend\/vite.*exactly "\/api"/,run(edit(VITE,'proxy: { "/api": "http://localhost:5000" }','proxy: { "/api/appointments": "http://localhost:5101", "/api": "http://localhost:5000" }'))],
      ['the Vite proxy target is not Core',/^fail-closed frontend\/vite.*exactly "\/api"/,run(edit(VITE,'"http://localhost:5000"','"http://localhost:5101"'))],
      ['a Vite proxy entry with an options object',/^fail-closed frontend\/vite.*shape this reader does not know/,run(edit(VITE,'"/api": "http://localhost:5000"','"/api": { target: "http://localhost:5000" }'))],
      ['a second proxy in the Vite config',/^fail-closed frontend\/vite.*exactly one proxy/,run(edit(VITE,'plugins: [react()],','plugins: [react()],\n  preview: { proxy: { "/api": "http://localhost:5101" } },'))],
      ['a proxy written in a Vite server hook',/^fail-closed frontend\/vite.*proxy written as code/,run(edit(VITE,'plugins: [react()],','plugins: [react(), { name: "x", configureServer(s) { s.middlewares.use(() => {}); } }],'))],
      // Core's routes
      ['an owned prefix mounted in mountSplitRoutes before the proxy',/^literal .*coreRoutes.*outside the legacy mounts/,run(edit(ROUTES,'  mountDirectory(app, db,',"  app.use('/api/notifications', requireAuth, localNotifications);\n  mountDirectory(app, db,"))],
      ['a second legacy mount of /api/appointments in the clinical block',/^literal .*coreRoutes.*(expected one legacy mount of \/api\/appointments|outside the legacy mounts)/,run(edit(ROUTES,"      '/api/medical-records',","      '/api/appointments',\n      requireAuth,\n      handler,\n    );\n    app.use(\n      '/api/medical-records',"))],
      ['the clinical legacy mounts lose their if (clinical) guard',/^literal .*coreRoutes.*expected one legacy mount of \/api\/appointments/,run(edit(ROUTES,'if (clinical) {','if (clinical || true) {'))],
      ['the legacy notifications mount loses its monolith guard',/^literal .*coreRoutes.*expected one legacy mount of \/api\/notifications/,run(edit(ROUTES,'if (monolith && clinical)','if (monolith)'))],
      ['an owned prefix with a path after it',/^literal .*coreRoutes.*\/api\/appointments outside the legacy mounts/,run(append(ROUTES,"app.get('/api/appointments/:id/summary', handler);"))],
      ['an owned prefix in a template literal',/^literal .*coreRoutes.*\/api\/notifications outside the legacy mounts/,run(append(ROUTES,'app.use(`/api/notifications/${x}`, handler);'))],
      ['an owned prefix written as two strings',/^literal .*coreRoutes.*\/api\/appointments outside the legacy mounts/,run(append(ROUTES,"const p = '/api/' + 'appointments';"))],
      // the nginx tokenizer reads # and quotes like nginx
      ['a quote inside a word does not open a string: the clinic location after it counts',/^table deploy/,run(edit(SPLIT,CORE,"set $a x'y; # '\n        "+VACC+"\n        set $b u' ;#x';\n        "+CORE))],
      ['a backslash-quote at the start of a word does not open a string either',/^table deploy/,run(edit(SPLIT,CORE,'set $a \\"y; # "\n        '+VACC+'\n        set $b u" ;#x";\n        '+CORE))],
      // regexes are read with the u flag, so PCRE-only syntax fails instead of matching nothing
      ['a PCRE \\A anchor',/^fail-closed deploy.*Invalid regular expression/,run(edit(SPLIT,CORE,'location ~ \\A/api/vaccinations { proxy_pass http://clinic; } '+CORE))],
      ['a PCRE \\Q…\\E quote',/^fail-closed deploy.*Invalid regular expression/,run(edit(SPLIT,CORE,'location ~ ^\\Q/api/vaccinations\\E { proxy_pass http://clinic; } '+CORE))],
      ['an inline (?i) flag',/^fail-closed deploy.*Invalid regular expression/,run(edit(SPLIT,CORE,'location ~ (?i)^/api/vaccinations { proxy_pass http://clinic; } '+CORE))],
      // structure of a core-ingress gateway, and probes with an id in them
      ['a numeric-id regex proxies /api/pets/<digits> to Clinic in a core-ingress gateway',/^fail-closed frontend\/nginx.*not to Core, in a core-ingress gateway/,run(edit(TEMPLATE,'location /api/ {','location ~ ^/api/pets/[0-9]+$ { proxy_pass http://clinic-api:5101; }\n    location /api/ {'))],
      ['a numeric-id regex sends /api/vaccinations/1 to Clinic',/^table deploy/,run(edit(SPLIT,CORE,'location ~ "^/api/vaccinations/[0-9]+$" { proxy_pass http://clinic; } '+CORE))],
      ['a uuid regex sends /api/pets/<uuid> to Clinic',/^table deploy/,run(edit(SPLIT,CORE,'location ~ "^/api/pets/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" { proxy_pass http://clinic; } '+CORE))],
      // a JS template is read once, and every proxy_pass of the file is in it
      ['a second direct template earlier in stack.mjs',/^fail-closed benchmarks.*#direct.*exactly one nginx template/,run({[STACK]:'const directConfig=`server { listen 127.0.0.1:${ports.gateway}; location /api/ { proxy_pass http://core; } }`;\n'+real.read(STACK)})],
      ['a second core-ingress template earlier in stack.mjs',/^fail-closed benchmarks.*#core-ingress.*exactly one nginx template/,run({[STACK]:'const coreIngressConfig=`server { listen 127.0.0.1:${ports.gateway}; location /api/ { proxy_pass http://core; } }`;\n'+real.read(STACK)})],
      ['a second nginx template earlier in resilience',/^fail-closed tools\/phase2\/resilience.*exactly one nginx template/,run({[RES]:'const config=`server {listen 127.0.0.1:${edge};location /api/ {proxy_pass http://core;}}`;\n'+real.read(RES)})],
      ['a proxy_pass outside the template that is read',/^fail-closed tools\/phase2\/resilience.*proxy_pass outside the template/,run(append(RES,"const decoy = 'proxy_pass http://clinic;';"))],
      ['a proxy_pass outside both templates of stack.mjs is counted by the direct place',/^fail-closed benchmarks.*#direct.*4 proxy_pass outside the template/,run(append(STACK,"const decoy = 'proxy_pass http://clinic;';"))],
      ['a proxy_pass outside both templates of stack.mjs is counted by the core-ingress place',/^fail-closed benchmarks.*#core-ingress.*6 proxy_pass outside the template/,run(append(STACK,"const decoy = 'proxy_pass http://clinic;';"))],
      ['a proxy_pass added to the Core edge (outside both templates) fails the direct place',/^fail-closed benchmarks.*#direct.*4 proxy_pass outside the template/,run(edit(STACK,'proxy_pass http://core_internal;','proxy_pass http://core_internal; proxy_pass http://clinic;'))],
      ['a proxy_pass added to the Core edge fails the core-ingress place too',/^fail-closed benchmarks.*#core-ingress.*6 proxy_pass outside the template/,run(edit(STACK,'proxy_pass http://core_internal;','proxy_pass http://core_internal; proxy_pass http://clinic;'))],
      // the two topologies of stack.mjs are two places that read the same file, each against its own template
      ['the direct template of stack.mjs without dashboard/clinic',/^table benchmarks\/phase2\/kaggle\/stack\.mjs#direct /,run(NO_DASHBOARD)],
      ['the direct template of stack.mjs without the notifications location',/^table benchmarks\/phase2\/kaggle\/stack\.mjs#direct /,run(edit(STACK,'location ~ ^/api/notifications(/|$) { ${headers} proxy_pass ${origins.notification}; } ',''))],
      ['the core-ingress template of stack.mjs with a Clinic location',/^fail-closed benchmarks\/phase2\/kaggle\/stack\.mjs#core-ingress: .*not to Core/,run(edit(STACK,'return 404; } location /api/ { ${coreGateway}','return 404; } location ~ ^/api/(appointments|medical-records|dashboard/clinic)(/|$) { ${headers} proxy_pass http://clinic; } location /api/ { ${coreGateway}'))],
      ['the core-ingress template of stack.mjs with a Notification location',/^fail-closed benchmarks\/phase2\/kaggle\/stack\.mjs#core-ingress: .*not to Core/,run(edit(STACK,'return 404; } location /api/ { ${coreGateway}','return 404; } location ~ ^/api/notifications(/|$) { ${headers} proxy_pass http://notification; } location /api/ { ${coreGateway}'))],
      ['the core-ingress template of stack.mjs is renamed',/^fail-closed benchmarks\/phase2\/kaggle\/stack\.mjs#core-ingress: exactly one nginx template expected in the file \(found 0\)/,run(edit(STACK,'const coreIngressConfig=','const coreIngressText='))],
      ['the direct template of stack.mjs is renamed',/^fail-closed benchmarks\/phase2\/kaggle\/stack\.mjs#direct: exactly one nginx template expected in the file \(found 0\)/,run(edit(STACK,'const directConfig=','const directText='))],
      ['two places that read the same file with the same template (the copy)',/^fail-closed benchmarks\/phase2\/kaggle\/stack\.mjs#copy: shares the file .* same template/,run({},{places:[...real.places,{...real.places.find(p=>p.id===DIRECT),id:STACK+'#copy'}]})],
      ['two places that read the same file with the same template (the original is reported too)',/^fail-closed benchmarks\/phase2\/kaggle\/stack\.mjs#direct: shares the file/,run({},{places:[...real.places,{...real.places.find(p=>p.id===DIRECT),id:STACK+'#copy'}]})],
      // the E2E proxy: every other fetch is the readiness probe, and no other way to forward
      ['new URL(req.url, clinic) then fetch(t) before the /api/ branch',/^fail-closed tools\/phase2\/e2e.*not the readiness probe/,run(e2eDetour('const t=new URL(req.url,origins.clinic);const r=await fetch(t,{method:req.method});'))],
      ['the request path copied to a variable before the /api/ branch',/^fail-closed tools\/phase2\/e2e.*not the readiness probe/,run(e2eDetour('const p=path;const r=await fetch(origins.clinic+p);'))],
      ['a fetch of a name built from the request URL',/^fail-closed tools\/phase2\/e2e.*not the readiness probe/,run(e2eDetour('const s=origins.clinic+new URL(req.url,origins.core).pathname;const r=await fetch(s);'))],
      ['http.request with a pipe instead of fetch',/^fail-closed tools\/phase2\/e2e.*another way to forward a request/,run(e2eDetour('const u=new URL(req.url,origins.clinic);http.request(u,x=>x.pipe(res)).end();'))],
      ['origins.core assigned after it is built',/^fail-closed tools\/phase2\/e2e.*origins is assigned/,run(edit(E2E,e2eBranch,'origins.core=origins.clinic;\n    '+e2eBranch))],
      // the frontend list is walked: types/generated and every script extension count, a fixture goes through the same filter
      ['a fetch in frontend/src/types/generated',/^fail-closed frontend\/src.*exactly one use of fetch.*types\/generated/,run({'frontend/src/types/generated/client.ts':"export const g = () => fetch('http://localhost:5101/api/appointments');"})],
      ['a fetch in a .jsx file',/^fail-closed frontend\/src.*exactly one use of fetch.*legacy\.jsx/,run({'frontend/src/legacy.jsx':"export const g = () => fetch('/x');"})],
      ['a fetch in a .mts file',/^fail-closed frontend\/src.*exactly one use of fetch.*tool\.mts/,run({'frontend/src/tool.mts':"export const g = () => fetch('/x');"})],
      ['a computed member of the global object',/^fail-closed frontend\/src.*computed key/,run({'frontend/src/o.ts':"export const g = () => (globalThis as any)['fe'+'tch']('/x');"})],
      ['another origin variable named like one (VITE_PROXY_HOST)',/^fail-closed frontend\/src.*one origin variable/,run({'frontend/src/o.ts':'export const h = import.meta.env.VITE_PROXY_HOST;'})],
      // the directives the gateway server may hold
      ['mirror in a gateway location',/^fail-closed deploy.*the directive mirror is not one the reader follows/,run(edit(SPLIT,CORE,'location /api/ { mirror /m; proxy_pass http://core; } location = /m { internal; proxy_pass http://clinic; }'))],
      ['auth_request in a gateway location',/^fail-closed deploy.*the directive auth_request is not one/,run(edit(SPLIT,CORE,'location /api/ { auth_request /auth; proxy_pass http://core; } location = /auth { proxy_pass http://clinic; }'))],
      ['proxy_cache in a gateway location',/^fail-closed deploy.*the directive proxy_cache is not one/,run(edit(SPLIT,CORE,'location /api/ { proxy_cache zone; proxy_pass http://core; }'))],
      ['a block the reader does not know in a gateway location',/^fail-closed deploy.*the directive map \(a block\)/,run(edit(SPLIT,CORE,'location /api/ { map $x $y { default 1; } proxy_pass http://core; }'))],
      ['mirror above the server (http level, inherited)',/^fail-closed deploy.*the directive mirror above the server/,run(edit(SPLIT,'proxy_http_version 1.1;','mirror /m;\n    proxy_http_version 1.1;'))],
      ['error_page to /api above the server (http level, inherited)',/^fail-closed deploy.*error_page jumps to \/api\/appointments/,run(edit(SPLIT,'proxy_http_version 1.1;','error_page 404 /api/appointments;\n    proxy_http_version 1.1;'))],
      ['error_page to a URL',/^fail-closed frontend\/nginx.*error_page jumps to http/,run(edit(TEMPLATE,'index index.html;','index index.html;\n    error_page 404 http://clinic-api:5101/;'))],
      ['error_page that lands in a proxied location',/^fail-closed deploy.*lands in a proxied location/,run(edit(SPLIT,CORE,'location /api/ { proxy_pass http://core; error_page 404 /m; } location = /m { proxy_pass http://clinic; }'))],
      // exceptions, the ignore list and the specs
      ['an exception that routes to something that is not a service',/^exception .*routesTo is not a service/,run(NO_DASHBOARD,{exceptions:[{...SYN,routesTo:'cor'}]})],
      ['a sweep ignore listed twice',/^sweep ignore .*listed twice/,run({},{ignore:[...real.ignore,real.ignore[0]]})],
      ['a second proxy in a file whose ignore names one',/^sweep ignore tools\/phase2\/billing\.test\.mjs: expected exactly one proxy/,run({[BILLING]:real.read(BILLING)+'\nawait fetch(base + req.url);\n'})],
      ['the Clinic spec lists a path outside /api/, /internal/, /health and /metrics',/^openapi \(e\) \/pets/,run(json(CLINIC_SPEC,p=>{p['/pets']={get:{}};}))],
      // exceptions
      ['an exception for a prefix that is not a gateway route',/^exception .*prefix is not one of gatewayRoutes/,run({},{exceptions:[{place:SPLIT,prefix:'/api',routesTo:'core',until:'2026-11-20',reason:'a reason that is long enough'}]})],
      ['an exception that waives a whole topology',/^exception .*prefix is not one of gatewayRoutes/,run(edit(SPLIT,'proxy_pass http://clinic;','proxy_pass http://core;'),{exceptions:[{place:SPLIT,prefix:'/api',routesTo:'core',until:'2026-11-20',reason:'a reason that is long enough'}]})],
      ['an exception with a date more than 60 days away',/^exception .*more than 60 days/,run(NO_DASHBOARD,{exceptions:[{...SYN,until:'2027-06-01'}]})],
      ['an exception listed twice',/^exception .*duplicate exception/,run(NO_DASHBOARD,{exceptions:[SYN,SYN]})],
      ['an exception with a day that does not exist',/^exception .*until is not a date/,run(NO_DASHBOARD,{exceptions:[{...SYN,until:'2026-02-30'}]})],
      // the OpenAPI files, both directions
      ['the Clinic spec lists a path the gateway spec does not',/^openapi \(d\) \/api\/appointments\/secret/,run(json(CLINIC_SPEC,p=>{p['/api/appointments/secret']={get:{}};}))],
      ['the gateway spec drops a path the Clinic spec still lists',/^openapi \(d\) \/api\/appointments\/calendar/,run(json('backend/openapi.json',p=>{delete p['/appointments/calendar'];}))],
    ];
    for(const [reason,tag,found] of fails)assert.ok(found.some(f=>tag.test(f)),'must fail ('+tag+'): '+reason+(found.length?'; got '+found[0]:'; got nothing'));
    // must pass: text a careless parser misreads
    const passes={
      'a commented-out Clinic location':run(edit(TEMPLATE,'location /api/ {','# location ~ ^/api/appointments(/|$) { proxy_pass http://clinic; }\n    location /api/ {')),
      'a comment with braces, a quote and a semicolon':run(edit(SPLIT,'location ~ ^/(internal',"# nothing; it's { odd\n        location ~ ^/(internal")),
      'CRLF line endings, split example':run({[SPLIT]:real.read(SPLIT).replace(/\r?\n/g,'\r\n')}),
      'CRLF line endings, compose template':run({[TEMPLATE]:real.read(TEMPLATE).replace(/\r?\n/g,'\r\n')}),
      'an exact location = /metrics':run(edit(SPLIT,'location / { return 404; }','location = /metrics { return 404; } location / { return 404; }')),
      'an exception on its last day':run(NO_DASHBOARD,{exceptions:[SYN],at:'2026-11-20'}),
      'a sweep ignore on its last day':run(STRAY_QUOTE,{ignore:[...real.ignore,SYN_IGNORE],at:'2026-11-20'}),
      'error_page 404 /index.html in the server (a single-page app)':run(edit(TEMPLATE,'index index.html;','index index.html;\n    error_page 404 /index.html;')),
      'the same error_page above the server':run(edit(SPLIT,'proxy_http_version 1.1;','error_page 404 /index.html;\n    proxy_http_version 1.1;')),
      'limit_except with deny in the gateway location':run(edit(SPLIT,CORE,'location /api/ { limit_except GET { deny all; } proxy_pass http://core; }')),
      'a nginx ${name} variable in the split example (a plain file is not a JS template)':run(edit(SPLIT,CORE,'location /api/ { proxy_set_header X-Request-Id ${req_id}; proxy_pass http://core; }')),
      'a comment with ${ in the split example':run(edit(SPLIT,'# Never enable','# costs ${ nothing\n    # Never enable')),
      'a server-level if that only sets a variable':run(edit(SPLIT,'location ~ ^/(internal','if ($uri ~ ^/api/vacc) { set $z 1; }\n        location ~ ^/(internal')),
      'a # inside a quoted add_header':run(edit(SPLIT,CORE,'add_header X "a # b"; '+CORE)),
      'CRLF line endings in stack.mjs':run({[STACK]:real.read(STACK).replace(/\r?\n/g,'\r\n')}),
      'a BOM at the start of the split example':run({[SPLIT]:'﻿'+real.read(SPLIT)}),
      'frontend text: "Failed to fetch", a key named fetch, obj.fetch, VITE_APP_TITLE and a dev link on 5173':run({'frontend/src/utils/ok.ts':'export const offline = (e: Error) => e.message === "Failed to fetch";\nexport const opts = { fetch: false };\nexport const t = import.meta.env.VITE_APP_TITLE ?? "Pet";\nexport const dev = "http://localhost:5173/";\nexport const q = (c: any) => c.fetch();'}),
      'a fetch inside a node_modules folder of frontend/src is not read':run({'frontend/src/node_modules/x.ts':"export const g = () => fetch('/x');"}),
      'a regex written ~^/ with no space (the same location)':run(edit(SPLIT,'location ~ ^/api/(appointments','location ~^/api/(appointments')),
      'a quoted regex and a quoted prefix (the same locations)':run(edits(SPLIT,[['location ~ ^/api/notifications(/|$)','location ~ "^/api/notifications(/|$)"'],['location /api/ {','location "/api/" {']])),
      'listen with default_server and an IPv6 line in the one server':run(edit(TEMPLATE,'listen 8080;','listen 8080 default_server;\n    listen [::]:8080;')),
      'listen 127.0.0.1:8080 with default_server':run(edit(SPLIT,'listen 127.0.0.1:8080;','listen 127.0.0.1:8080 default_server;')),
      'an if with a 4xx return in the gateway location':run(edit(TEMPLATE,'location /api/ {','location /api/ {\n        if ($request_method = TRACE) { return 405; }')),
      'a try_files fallback to a page':run(edit(TEMPLATE,'try_files $uri =404;','try_files $uri /404.html;')),
      'the E2E forward written as a template literal to Core':run(edit(E2E,e2eForward,'fetch(`${origins.core}${req.url}`')),
      'an image URL and a comment about fetch( in another frontend file':run({'frontend/src/ok.ts':"export const img = 'https://img.example/pet.png'; // fetch( and https://x.example/api/y are only a comment"}),
    };
    for(const [reason,found] of Object.entries(passes))assert.deepEqual(found,[],'must pass: '+reason+': '+found.join('; '));
    // the selector follows nginx: = first, longest prefix, ^~ stops the regexes, then regexes in order, then the prefix
    const pick=(conf,path)=>nginxRoute(nginxLocations('server { listen 1; '+conf+' }','1'),path)?.target??null;
    const selector=[
      ['= beats regex and prefix','location /a { proxy_pass P; } location ~ ^/a$ { proxy_pass R; } location = /a { proxy_pass E; }','/a','E'],
      ['= is exact only','location /a { proxy_pass P; } location = /a { proxy_pass E; }','/a/b','P'],
      ['the longest prefix wins, shorter first','location /a/ { proxy_pass S; } location /a/b/ { proxy_pass L; }','/a/b/c','L'],
      ['the longest prefix wins, longer first','location /a/b/ { proxy_pass L; } location /a/ { proxy_pass S; }','/a/b/c','L'],
      ['^~ stops the regexes','location ^~ /a/ { proxy_pass N; } location ~ ^/a/b { proxy_pass R; }','/a/b','N'],
      ['a plain prefix loses to a regex','location /a/ { proxy_pass P; } location ~ ^/a/b { proxy_pass R; }','/a/b','R'],
      ['the first matching regex wins','location ~ ^/a { proxy_pass R1; } location ~ ^/a/b { proxy_pass R2; }','/a/b','R1'],
      ['~ is case-sensitive','location ~ ^/a { proxy_pass S; }','/A',null],
      ['~* is not','location ~* ^/a { proxy_pass I; }','/A','I'],
      ['the prefix answers when no regex matches','location /a/ { proxy_pass P; } location ~ ^/b { proxy_pass R; }','/a/x','P'],
      ['nothing matches','location /a/ { proxy_pass P; }','/b',null],
      ['a location without proxy_pass has no target','location /a/ { return 404; }','/a/x',null],
    ];
    for(const [reason,conf,path,want] of selector)assert.equal(pick(conf,path),want,'selector: '+reason);
    const words=text=>nginxTokens(text).map(t=>t.v??t.t);
    assert.deepEqual(words('a;# x\r\nb;# y'),['a',';','b',';'],'a comment ends at the line end, CRLF or LF');
    assert.deepEqual(words("add_header X 'a; # kept'; # gone"),['add_header','X','a; # kept',';'],'a # inside quotes is text');
    assert.deepEqual(words('proxy_pass http://h/a#b;'),['proxy_pass','http://h/a#b',';'],'a # inside a token is text');
    assert.deepEqual(words("set $a x'y; # '\nb;"),['set','$a',"x'y",';','b',';'],'a quote inside a word is text, so the comment after it ends at its own line');
    assert.deepEqual(words('set $a \\"y; # "\nb;'),['set','$a','\\"y',';','b',';'],'a backslash-quote at the start of a word is text too');
    assert.deepEqual(words('x "a \\" # b" y'),['x','a " # b','y'],'a backslash inside a string escapes the quote');
    assert.deepEqual(words('add_header X ${req_id}; return 404}'),['add_header','X','${req_id}',';','return','404}'],'${name} is one word and a } inside a word is text');
    // the parser reads a location name and a listen port as nginx does
    const names=[
      [['/api/'],'','/api/'],[['='  ,'/a'],'=','/a'],[['=/a'],'=','/a'],[['^~/a'],'^~','/a'],[['~^/a'],'~','^/a'],[['~*^/a'],'~*','^/a'],[['~','^/a(/|$)'],'~','^/a(/|$)'],
    ];
    for(const [args,modifier,path] of names)assert.deepEqual(locationName(args),{modifier,path},'location '+args.join(' '));
    for(const bad of [['@x'],['=','/a','/b'],['!','/a']])assert.throws(()=>locationName(bad),/named location|accept/,'location '+bad.join(' '));
    const listens=[['8080','8080'],['127.0.0.1:8080','8080'],['*:8080','8080'],['[::]:8080','8080'],['localhost:8080','8080'],['127.0.0.1:${p}','${p}'],['${p}','${p}'],['127.0.0.1',null],['[::]',null],['unix:/tmp/x.sock',null]];
    for(const [arg,port] of listens)assert.equal(listenPort(arg),port,'listen '+arg);
    assert.deepEqual(nginxTokens('a "b ; {" \'\' c${x}d; }').map(t=>t.v??t.t),['a','b ; {','','c${x}d',';','}'],'quotes hold ; and {, ${…} stays in a word');
    assert.throws(()=>nginxLocations('server { listen 1; location /a { proxy_pass x }','1'),/no ;|not closed/,'a block that is not closed');
    assert.throws(()=>nginxLocations('server { listen 1; location /a { proxy_pass x; }','1'),/not closed/,'a server that is not closed');
    // the JS reader: comments and strings, calls, the sweep
    const commented="a('x//y'); // c\nb(/^\\/api\\//); /* d */ c(`//${'/*'}`)";
    assert.equal(stripJsComments(commented).replace(/ +/g,' '),"a('x//y'); \nb(/^\\/api\\//); c(`//${'/*'}`)",'comments blanked, a // inside a string, a regex or a template stays');
    assert.equal(stripJsComments(commented).length,commented.length,'every offset stays');
    assert.equal(fetchUses("const m = 'Failed to fetch'; const o = { fetch: false }; obj.fetch(1); globalThis.fetch(2); fetch(3); // fetch\nconst t = `${fetch(4)} fetch`; /fetch/.test(x); window . fetch(5);").length,4,'fetch counts as code only: not in a string, a comment, a regex, as a key or as obj.fetch');
    assert.deepEqual(fetchCalls("window.fetch(`${a}/x`, {m:(1,2)}); prefetch(1); fetch(b + c)").map(c=>c.arg),['`${a}/x`','b+c'],'fetch calls with their first argument');
    assert.deepEqual(callArguments('f(a, [1,2], g(3,4), "x,y")',1).args,['a',' [1,2]',' g(3,4)',' "x,y"'],'call arguments split at top-level commas');
    const tree={'/r':['phase2-plan','tools','a.json'],'/r/phase2-plan':['evidence','plan.json'],'/r/phase2-plan/evidence':['k.conf'],'/r/tools':['evidence','c.conf','node_modules'],'/r/tools/evidence':['b.conf'],'/r/tools/node_modules':['z.conf']};
    const fakeFs={readdirSync:dir=>tree[dir.replaceAll('\\','/')].map(name=>({name,isDirectory:()=>(dir.replaceAll('\\','/')+'/'+name) in tree})),statSync:()=>({size:1})};
    assert.deepEqual(sweepFiles('/r',fakeFs).sort(),['a.json','phase2-plan/plan.json','tools/c.conf','tools/evidence/b.conf'],'the sweep skips phase2-plan/evidence by its path, and a directory called evidence elsewhere is swept');
    return real.places.length+' places, '+analyze(contracts,real).probes.length+' probes, '+real.exceptions.length+' exceptions ('+exceptionDays(today,real).join('; ')+'); no proxy outside the places or the ignore list; '+fails.length+' must-fail, '+Object.keys(passes).length+' must-pass and '+(selector.length+7+names.length+3+listens.length+9)+' parser fixtures';
  }),error=>rule('gateway-routes-single-source',()=>{throw error;}));

await envelopeCheck;
await routingCheck;
await callsCheck;
await lifecycleCheck;
await grantsCheck;
await permissionCheck;
await consumerCheck;
await categoryCheck;
const failed=results.filter(r=>r.status!=='PASS');
for(const r of results)process.stdout.write(`${r.status.padEnd(4)} ${r.rule}${r.detail?' — '+r.detail:''}\n`);
if(failed.length)process.exitCode=1;
else process.stdout.write(`Architecture rules PASS (${results.length} rules): service layering, event contracts, gateway exposure, runtime grants, permission matrix, shared OpenAPI schemas, notification tabs, deferred reads, Clinic routes declare their scope, no duplicated service modules, service calls declared, shared packages without business routes, services declare limit rules, structure ratchet, Core module map, legacy isolation, gateway routes from one source, negative fixtures.\n`);
