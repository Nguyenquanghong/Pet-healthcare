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
export function bindings(messagingSource){return [...messagingSource.matchAll(/bindQueue\(t\.(\w+),\s*t\.exchange,\s*'([^']+)'\)/g)].map(m=>({queue:m[1],key:m[2]}));}
export function declaredTypes(contractsSource){const m=contractsSource.match(/export const eventTypes\s*=\s*\[([^\]]+)\]/);return m?[...m[1].matchAll(/'([^']+)'/g)].map(x=>x[1]):[];}
export function emittedTypes(source,families){return [...source.matchAll(/['"`]([a-z]+\.[a-z]+(?:-[a-z]+)*\.v\d+)['"`]/g)].map(m=>m[1]).filter(t=>families.has(t.split('.')[0]));}
const contractsSource=read('packages/contracts/src/index.ts'),types=declaredTypes(contractsSource),families=new Set(types.map(t=>t.split('.')[0]));
rule('event-types-declared-and-bound',()=>{
  assert.ok(types.length>0,'no eventTypes found');
  const bound=bindings(read('packages/messaging/src/index.ts'));
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
const GATEWAYS=['deploy/phase2/nginx.split.conf.example','benchmarks/phase2/kaggle/stack.mjs','tools/phase2/cqrs/activity/kaggleD5.mjs'];
export const blocksInternal=source=>/location\s+~\s+\^\/\(internal\|metrics\|health\)\s*\{\s*return\s+404;\s*\}/.test(source);
rule('gateway-hides-internal-routes',()=>{
  const missing=GATEWAYS.filter(g=>!blocksInternal(read(g)));
  assert.deepEqual(missing,[],'gateway without /internal|/metrics|/health block: '+missing.join(', '));
  assert.equal(blocksInternal('location /api/ { proxy_pass http://core; }'),false);
  return GATEWAYS.length+' gateway configs';
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
  .then(({permissions})=>rule('permissions-from-matrix',()=>{
    const scanned=SERVICE_SOURCES.flatMap(d=>files(resolve(root,d))).filter(f=>f.endsWith('.ts')&&!AUTHORIZATION.has(relative(root,f).split(sep).join('/')));
    const bad=scanned.flatMap(f=>permissionViolations(readFileSync(f,'utf8')).map(v=>relative(root,f)+' '+v));
    assert.deepEqual(bad,[],'role decisions outside the permission matrix: '+bad.join('; '));
    const all=scanned.map(f=>readFileSync(f,'utf8')).join('\n');
    const unused=permissions.filter(p=>!checked(all,p));
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

await envelopeCheck;
await grantsCheck;
await permissionCheck;
const failed=results.filter(r=>r.status!=='PASS');
for(const r of results)process.stdout.write(`${r.status.padEnd(4)} ${r.rule}${r.detail?' — '+r.detail:''}\n`);
if(failed.length)process.exitCode=1;
else process.stdout.write('Architecture rules PASS: layering, event contracts, gateway exposure, runtime grants, permission matrix, negative fixtures.\n');
