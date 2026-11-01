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
// 11. Clinic reaches other systems over HTTP only from infrastructure/core/directory.ts and
//     infrastructure/core/directorySync.ts (the Core calls, ADR-P13) and infrastructure/blob/blobStore.ts
//     (object storage, not Core).
// 12. Structure ratchet: the measured structure metrics (tools/phase2/arch-metrics.mjs) never get
//     worse than tools/phase2/arch-baseline.json; an improvement passes and asks to lower the baseline.
// 13. Shared packages (contracts excepted) name no service route: no literal path under /api/, /auth/ or /public/.
// 14. Every createRuntime call site in the services names limitRules (an empty list is an explicit choice).
// 15. Clinic's routes are declared only as elements of the registry (http/routes), each naming its resource: no
//     router.get/post/patch/put/delete/all in http/routes, http/scope.ts or app.ts.
// 16. Core module map (K3): every backend/src file belongs to one group of tools/phase2/core-modules.json; an import between
//     two groups, and a table one group reads that another owns, must be declared there (and a declaration nothing uses fails).
// Each rule also runs a negative fixture so a broken rule fails loudly.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

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

// ---- 11. Clinic -> Core calls stay confined (ADR-P13) -----------------------------------
// Clinic's synchronous dependency on Core is read-only authorization and lookup. Keeping every
// outbound HTTP call in these files means a new Core call is a visible change to this list.
const CLINIC_HTTP_FILES = new Map([
  ['infrastructure/core/directory.ts', 'Core authorize / lookup / terminal evidence'],
  ['infrastructure/core/directorySync.ts', 'Core directory export for the projection'],
  ['infrastructure/blob/blobStore.ts', 'S3-compatible object storage (not Core)'],
]);
// A call to fetch, any reference to globalThis.fetch, or a static, dynamic or required import of an HTTP/socket client module.
const HTTP_CALL = /(?:^|[^\w$])fetch\s*\(|\bglobalThis\s*(?:\.\s*fetch\b|\[\s*['"]fetch['"])|\b(?:from|import|require)\s*\(?\s*['"](?:(?:node:)?(?:https?|http2|net|tls)|undici|axios|node-fetch|got)['"]/;
export function unconfinedHttpCalls(modules, allowed = CLINIC_HTTP_FILES) {
  return modules.filter(m => !allowed.has(m.file) && HTTP_CALL.test(withoutComments(m.source))).map(m => m.file);
}
rule('clinic-core-calls-confined', () => {
  const src = resolve(root, 'services/clinic/src');
  const modules = files(src).filter(f => f.endsWith('.ts')).map(f => ({ file: relative(src, f).split(sep).join('/'), source: readFileSync(f, 'utf8') }));
  assert.ok(modules.length >= 40, 'found the Clinic modules (' + modules.length + ')');
  const stray = unconfinedHttpCalls(modules);
  assert.deepEqual(stray, [], 'outbound HTTP outside ' + [...CLINIC_HTTP_FILES.keys()].join(', ') + ' (add it to the list with a reason, or call Core through directory.ts): ' + stray.join(', '));
  const listed = [...CLINIC_HTTP_FILES.keys()].filter(f => !modules.some(m => m.file === f && HTTP_CALL.test(withoutComments(m.source))));
  assert.deepEqual(listed, [], 'listed files that no longer make a call (remove them): ' + listed.join(', '));
  // negative fixtures
  const at = (file, source) => unconfinedHttpCalls([{ file, source }]);
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
  return modules.length + ' modules; HTTP only in ' + [...CLINIC_HTTP_FILES.keys()].join(', ');
});

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
const {measure,baselineOf,ciJobsRunning,LEGACY_APP,PRODUCTION_APP,walk,importEdges}=await import(pathToFileURL(resolve(root,'tools/phase2/arch-metrics.mjs')).href);
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
  assert.ok(LEGACY_APP.test("const {createApp}=await import('../../backend/dist/src/app.js');")&&LEGACY_APP.test("import { createApp } from '../src/app.js';"));
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

// ---- 16. Core module map (K3) -----------------------------------------------------------------
// tools/phase2/core-modules.json: the groups of backend/src (contexts, and the kernel, dto, read, clinical and platform groups
// that are not contexts). An import that crosses two groups is declared in `edges`, a table one group reads that another owns in
// `dataEdges` (K4 removes them); a declaration nothing uses any more fails. Free by kind: anything may import the kernel,
// platform (composition, workers, entries) imports every group and no other group imports it, read imports every group, routes
// import dto and dto imports the ports it maps.
const GROUP_KINDS = ['context', 'kernel', 'dto', 'read', 'platform'];
const inPattern = (path, pattern) => (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);
// A Prisma delegate (tx|client|db.<delegate>.<call>) and the table a raw SQL template names after FROM, JOIN, INTO or UPDATE.
const DATA_DELEGATE = /\b(?:tx|client|db)\.([A-Za-z_$][\w$]*)\.(?:find\w*|create\w*|update\w*|upsert|delete\w*|count|aggregate|groupBy)\s*[(<]/g;
const RAW_SQL = /\$(?:queryRaw|executeRaw)\s*(?:<[^`]*?>)?\s*`([^`]*)`/g;
const SQL_TABLE = /(?:\bFROM|\bJOIN|\bINTO|(?<!\bFOR\s+|\bDO\s+)\bUPDATE)\s+"?([A-Za-z_]\w*)"?/gi;
export function tablesRead(source) {
  const code = withoutComments(source), names = new Set();
  for (const m of code.matchAll(DATA_DELEGATE)) names.add(m[1]);
  for (const sql of code.matchAll(RAW_SQL)) for (const m of sql[1].matchAll(SQL_TABLE)) names.add(m[1]);
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
  const free = (from, to, a, b) => kind(from) === 'platform' || kind(to) === 'kernel' || kind(from) === 'read' || (kind(from) === 'dto' && b.startsWith('application/ports/')) || (kind(to) === 'dto' && a.startsWith('routes/'));
  const real = new Map();
  for (const { file, source } of modules) {
    const from = groupOf.get(file);
    if (!from) continue;
    for (const target of importEdges(abs(file), source, known)) {
      const to = groupOf.get(relOf.get(target)), b = relOf.get(target);
      if (!to || to === from) continue;
      if (kind(to) === 'platform' && kind(from) !== 'platform') found.push(file + ' imports ' + b + ': only platform may import platform');
      else if (!free(from, to, file, b) && !real.has(from + ' -> ' + to)) real.set(from + ' -> ' + to, file + ' -> ' + b);
    }
  }
  const declared = new Map(edges.map(e => [e.from + ' -> ' + e.to, e]));
  for (const [key, e] of declared) if (!groups[e.from] || !groups[e.to]) found.push('edge ' + key + ' names a group that does not exist');
  for (const [key, example] of real) if (!declared.has(key)) found.push(key + ' is not in edges (first import: ' + example + ')');
  for (const key of declared.keys()) if (!real.has(key)) found.push('edge ' + key + ' is declared but no file imports it any more');
  const owner = new Map(Object.entries(tables).flatMap(([group, names]) => names.map(name => [name, group])));
  const realData = new Map();
  for (const { file, source } of modules) {
    const from = groupOf.get(file);
    if (!from || kind(from) === 'platform') continue;
    for (const name of tablesRead(source)) {
      const to = owner.get(name);
      if (!to) found.push(file + ' reads ' + name + ', which no group owns in tables');
      else if (to !== from && kind(to) !== 'kernel' && kind(from) !== 'read' && kind(from) !== 'dto' && !realData.has(from + ' -> ' + to)) realData.set(from + ' -> ' + to, file + ' reads ' + name);
    }
  }
  const declaredData = new Set(dataEdges.map(e => e.from + ' -> ' + e.to));
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
  assert.deepEqual(at(toPlatform), ['application/services/pets.ts imports composition/http.ts: only platform may import platform'], 'a context imports platform');
  assert.ok(at(toPlatform, { edges: [edge('directory', 'platform')] }).includes('application/services/pets.ts imports composition/http.ts: only platform may import platform'), 'declaring the edge does not allow it');
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
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;'), [], 'a raw SQL table of its own, FOR UPDATE is not a table');
  assert.deepEqual(dataEdge('await tx.hotelBooking.update({}); await tx.outboxEvent.create({});'), [], 'its own table and a kernel table');
  assert.deepEqual(dataEdge('// await tx.invoice.findUnique({});'), [], 'a comment reads nothing');
  assert.deepEqual(dataEdge('await tx.mystery.findMany({});'), [hotelRepo + ' reads mystery, which no group owns in tables'], 'a delegate no group owns');
  assert.deepEqual(dataEdge('await tx.$queryRaw`SELECT id FROM mystery_table`;'), [hotelRepo + ' reads mystery_table, which no group owns in tables'], 'a raw SQL table no group owns');
  assert.deepEqual(dataEdge('', { dataEdges: [edge('hotel', 'billing')] }), ['data edge hotel -> billing is declared but no file reads it any more'], 'a declared data edge that is gone');
  assert.deepEqual(at([['infrastructure/persistence/listsRepository.ts', 'await tx.invoice.findMany({});'], ['composition/coreRoutes.ts', 'await db.user.findUnique({});']]), [], 'read and platform read any table');
  return Object.keys(config.groups).length + ' groups, ' + config.edges.length + ' edges, ' + config.dataEdges.length + ' data edges, ' + modules.length + ' modules';
});

await envelopeCheck;
await lifecycleCheck;
await grantsCheck;
await permissionCheck;
await consumerCheck;
await categoryCheck;
const failed=results.filter(r=>r.status!=='PASS');
for(const r of results)process.stdout.write(`${r.status.padEnd(4)} ${r.rule}${r.detail?' — '+r.detail:''}\n`);
if(failed.length)process.exitCode=1;
else process.stdout.write(`Architecture rules PASS (${results.length} rules): service layering, event contracts, gateway exposure, runtime grants, permission matrix, shared OpenAPI schemas, notification tabs, deferred reads, Clinic routes declare their scope, no duplicated service modules, Clinic HTTP calls confined, shared packages without business routes, services declare limit rules, structure ratchet, negative fixtures.\n`);
