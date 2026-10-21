// Local provenance only: reads code/builds and constructs synthetic data in memory.
// No service startup, database connection, seed or performance measurement.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildActivityFixture} from './fixture.mjs';

const evidence='phase2-plan/cqrs/clinic-activity/evidence';
const digest=value=>createHash('sha256').update(value).digest('hex');
const entry=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:digest(bytes)};};
const tree=path=>readdirSync(path).flatMap(name=>{const child=path+'/'+name;return statSync(child).isDirectory()?tree(child):[child];});
const hashList=list=>digest(JSON.stringify(list));
const previousPath=evidence+'/d0-source-manifest.json',previous=JSON.parse(readFileSync(previousPath,'utf8'));
const extra=[
  'services/clinic/src/application/ports/clinicActivityQueries.ts',
  'services/clinic/src/application/queries/clinicActivity.ts',
  'services/clinic/src/infrastructure/queries/clinicActivity.ts',
  'frontend/src/components/admin/ClinicActivitySection.tsx',
  'frontend/src/services/clinicActivity.ts','frontend/src/types/clinicActivity.ts',
  'tools/phase2/ui/activity.spec.ts',...tree('tools/phase2/cqrs/activity'),
];
const files=[...new Set([...previous.files.map(e=>e.path),...extra])].sort().map(entry);
const changed=files.filter(e=>previous.files.find(old=>old.path===e.path)?.sha256!==e.sha256);
const artifacts=[...tree('backend/dist'),...tree('services/clinic/dist'),...tree('frontend/dist'),
  ...tree('packages/runtime/dist'),...tree('packages/contracts/dist'),...tree('packages/messaging/dist')].sort().map(entry);
const clients=['backend/src/generated/phase2-core','services/clinic/src/generated/client'].flatMap(tree).sort().map(entry);
// Current schemas use one field/attribute per line. Compare each named block
// ignoring formatting/comments and attribute ordering, without modifying clients.
const schemaBlocks=path=>Object.fromEntries([...readFileSync(path,'utf8').replace(/\/\/[^\n]*/g,'').matchAll(/((?:model|enum|generator|datasource)\s+\w+)\s*{([^}]*)}/g)]
  .map(([,name,body])=>[name,body.split('\n').filter(s=>s.trim()).map(s=>s.replace(/\s+/g,'')).sort()]));
const schemas=[['backend/prisma/phase2/schema.prisma','backend/src/generated/phase2-core/schema.prisma'],
  ['services/clinic/prisma/schema.prisma','services/clinic/src/generated/client/schema.prisma']].map(([source,client])=>{
    assert.deepEqual(schemaBlocks(source),schemaBlocks(client),'Generated client schema differs from source: '+source);
    return {source:entry(source),client:entry(client),namedBlocksMatchIgnoringFormattingAndAttributeOrder:true};
  });
const fixtures=[10000,100000].map(rows=>{
  const f=buildActivityFixture({rows}),pets=new Map(f.pets.map(p=>[p.id,p])),owners=new Set(f.owners.map(o=>o.id));
  assert.equal(new Set(f.appointments.map(a=>a.id)).size,rows);
  assert.equal(new Set(f.appointments.map(a=>[a.petId,a.appointmentDate,a.appointmentTime].join('|'))).size,rows);
  assert.ok(f.pets.every(p=>owners.has(p.ownerId)));
  assert.ok(f.appointments.every(a=>pets.get(a.petId)?.ownerId===a.ownerId&&/^([01]\d|2[0-3]):[0-5]\d$/.test(a.appointmentTime)));
  const populated=new Map();for(const a of f.appointments)populated.set(a.appointmentDate,(populated.get(a.appointmentDate)??0)+1);
  assert.ok(![...populated.keys()].some(d=>d.slice(5,7)==='02'));assert.ok(!populated.has('2030-10-13'));
  return {...f.manifest,ownerCount:f.owners.length,petCount:f.pets.length,populatedDays:populated.size,
    anchorDayRows:populated.get('2030-10-20')??0,maxRowsPerDay:Math.max(...populated.values()),
    validation:'PASS_IN_MEMORY_ONLY; not inserted or verified in PostgreSQL/Core'};
});
const manifest={format:'clinic-activity-d1-development-manifest-v1',capturedAtUtc:new Date().toISOString(),
  kind:'LOCAL_SOURCE_BUILD_FIXTURE_HARNESS_NOT_TRIAL_OR_PERFORMANCE',
  branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),
  head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirtyWorkingTree:true,
  host:{platform:process.platform,arch:process.arch,node:process.version,
    npm:(process.platform==='win32'?execFileSync('cmd.exe',['/d','/s','/c','npm --version'],{encoding:'utf8'}):execFileSync('npm',['--version'],{encoding:'utf8'})).trim()},
  priorD0Audit:entry(previousPath),
  scope:'D0 audited source paths plus D1 code/tests/harness; excludes documentation/policy/generated outputs from source list; builds and existing generated clients listed separately.',
  hashConvention:'SHA256 of actual working-copy bytes; list digest = SHA256 UTF-8 JSON.stringify(entries in path order).',
  sourceTreeSha256:hashList(files),files,changedFromD0Audit:changed,
  build:{sha256:hashList(artifacts),artifacts,generatedClients:{sha256:hashList(clients),files:clients,schemas},
    existingClientsReused:true,prismaGenerate:'NOT_RUN_SUCCESSFULLY; unchanged schemas, existing clients copied by build scripts',
    trialBuild:false},
  fixtureBuilder:entry('tools/phase2/cqrs/activity/fixture.mjs'),fixtures,
  trace:{status:'NOT_IMPLEMENTED_NOT_RUN',sha256:null},performanceMeasurements:'NOT_RUN',
  database:{connections:0,mutations:0,parity:'NOT_RUN'},
};
const path=evidence+'/d1-development-manifest.json',bytes=JSON.stringify(manifest,null,2)+'\n';
writeFileSync(path,bytes);writeFileSync(path.replace('.json','.sha256'),digest(bytes)+'  d1-development-manifest.json\n');
console.log(JSON.stringify({manifest:path,sha256:digest(bytes),sourceTreeSha256:manifest.sourceTreeSha256,sourceFiles:files.length,changedFiles:changed.length,buildFiles:artifacts.length,fixtures},null,2));
