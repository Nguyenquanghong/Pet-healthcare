// Architecture fitness functions not covered by check-boundaries.mjs (inter-service
// imports/SQL/clients) or backend/scripts/check-architecture.mjs (Core layering):
//  1. Clinic layering: domain/ and application/ never import Express, Prisma, the
//     generated client, amqplib, infrastructure or adapter modules.
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
//     gate only opens for GET on the exact path with a closed breaker and fails closed.
// 10. No two .ts files in services/*/src or backend/src/phase2 are identical: a copy
//     belongs in packages/runtime or packages/messaging.
// 11. Clinic reaches other systems over HTTP only from infrastructure/core/directory.ts and
//     infrastructure/core/directorySync.ts (the Core calls, ADR-P13) and infrastructure/blob/blobStore.ts
//     (object storage, not Core).
// 12. Structure ratchet: the measured structure metrics (tools/phase2/arch-metrics.mjs) never get
//     worse than tools/phase2/arch-baseline.json; an improvement passes and asks to lower the baseline.
// 13. Shared packages (contracts excepted) name no service route: no literal path under /api/, /auth/ or /public/.
// 14. Every createRuntime call site in the services names limitRules (an empty list is an explicit choice).
// Each rule also runs a negative fixture so a broken rule fails loudly.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'../..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.name==='generated'?[]:e.isDirectory()?files(resolve(dir,e.name)):[resolve(dir,e.name)]);
const results=[];
const rule=(name,fn)=>{try{const detail=fn();results.push({rule:name,status:'PASS',detail});}catch(error){results.push({rule:name,status:'FAIL',detail:error.message});}};

// ---- 1. Clinic layering --------------------------------------------------------
const clinicSrc=resolve(root,'services/clinic/src');
const FORBIDDEN=/^(express|@prisma\/client|amqplib|ioredis|redis|pg)$|generated\//;
export function layerViolations(file,source,src=clinicSrc){
  const layer=relative(src,file).split(sep)[0],allowed=layer==='domain'?['domain']:['domain','application'],found=[];
  for(const m of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])([^'"]+)\1/g)){
    const spec=m[2];
    if(FORBIDDEN.test(spec)){found.push(spec);continue;}
    if(spec.startsWith('.')){const target=relative(src,resolve(dirname(file),spec)).split(sep)[0];if(!allowed.includes(target))found.push(spec);}
  }
  return found;
}
rule('clinic-layering',()=>{
  const scanned=['domain','application'].flatMap(l=>files(resolve(clinicSrc,l))).filter(f=>f.endsWith('.ts'));
  const bad=scanned.flatMap(f=>layerViolations(f,readFileSync(f,'utf8')).map(s=>relative(root,f)+' -> '+s));
  assert.deepEqual(bad,[],'layer violations: '+bad.join(', '));
  // negative fixtures
  assert.ok(layerViolations(resolve(clinicSrc,'application/x.ts'),"import type { X } from '../directory.js'").length);
  assert.ok(layerViolations(resolve(clinicSrc,'application/x.ts'),"import { PrismaClient } from '../generated/client/index.js'").length);
  assert.ok(layerViolations(resolve(clinicSrc,'application/x.ts'),"import express from 'express'").length);
  assert.ok(layerViolations(resolve(clinicSrc,'domain/x.ts'),"import { a } from '../application/ports/a.js'").length);
  assert.equal(layerViolations(resolve(clinicSrc,'application/x.ts'),"import { a } from '../domain/a.js'").length,0);
  return scanned.length+' files';
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
  const source=read('backend/src/phase2/coreApp.ts');
  assert.deepEqual(directFetches(source),[],'coreApp.ts calls fetch directly; route it through serviceProxy');
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
const DEFERRED_GATE=[
  [/req\.method\s*===\s*'GET'\s*&&\s*route\.deferred\b/,'the deferred gate does not require GET'],
  [/req\.path\s*===\s*route\.path\b/,'the deferred gate does not match the exact path'],
  [/breaker\?\.state\s*===\s*'closed'/,'the deferred gate does not require a closed breaker'],
  [/\bfailClosed\(/,'the deferred gate does not fail closed'],
];
// A route element is `{ method: 'get', path: '/x', ...` up to the next element (or the end of the array): its handler is in it.
export function deferredRouteViolations(routeSource,gateSource){
  const found=[],elements=routeSource.split(/\{\s*method:\s*'/).slice(1).map(text=>{
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
  for(const [pattern,message] of DEFERRED_GATE)if(!pattern.test(gateSource))found.push(message);
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
  const goodGate="if (req.method === 'GET' && route.deferred && req.path === route.path && source.breaker?.state === 'closed') { failClosed(res, d); next(); }";
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
  const dirs=[...readdirSync(resolve(root,'services'),{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>'services/'+e.name+'/src'),'backend/src/phase2'];
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
const withoutComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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

// ---- 12. Structure ratchet ---------------------------------------------------------------
// Each non-manual metric has a direction ("lower" or "higher" is better). Worse than the baseline fails; better passes
// and reminds to lower the baseline so the gain cannot be lost later. Manual metrics are declared, never compared.
const {measure,ciJobsRunning,LEGACY_APP,PRODUCTION_APP}=await import(pathToFileURL(resolve(root,'tools/phase2/arch-metrics.mjs')).href);
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
  assert.ok(PRODUCTION_APP.test("const {createCoreApp}=await import('../../backend/dist/src/phase2/coreApp.js');")&&!PRODUCTION_APP.test("import('../../backend/dist/src/app.js')"));
  // the real measurement against a baseline made stricter by one
  const strict=structuredClone(baseline),first=Object.values(strict.metrics).find(m=>m.kind!=='manual'&&m.better==='lower'&&Object.values(m.values).some(v=>v>0));
  const key=Object.keys(first.values).find(k=>first.values[k]>0);first.values[key]-=1;
  assert.equal(ratchetFindings(current,strict).worse.length,1,'a stricter baseline must fail');
  return Object.values(current.metrics).filter(m=>m.kind!=='manual').length+' metrics held'+(better.length?'; improved, lower the baseline ('+RATCHET_FIX+'): '+better.join(', '):'');
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
else process.stdout.write('Architecture rules PASS: layering, event contracts, gateway exposure, runtime grants, permission matrix, shared OpenAPI schemas, notification tabs, deferred reads, no duplicated service modules, Clinic HTTP calls confined, shared packages without business routes, services declare limit rules, structure ratchet, negative fixtures.\n');
