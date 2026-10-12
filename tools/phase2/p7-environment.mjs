import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {PrismaClient} from '@prisma/client';
import {PrismaClient as ClinicClient} from '../../services/clinic/src/generated/client/index.js';
import {PrismaClient as NotificationClient} from '../../services/notification/src/generated/client/index.js';
import {assertTestProject} from './test-project.mjs';

export const components=['legacy','core','clinic','notification','restore'];
export const ident=value=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))throw new Error('P7_INVALID_IDENTIFIER');return '"'+value+'"';};
export function artifact(file){const root=resolve('test-results/phase2'),path=resolve(file),rel=relative(root,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('P7_ARTIFACT_SCOPE_REQUIRED');return path;}
export function assertContext(ctx){
  if(ctx?.version!==1||ctx.project!=='pet-phase2-p1-test'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ctx.run))throw new Error('P7_INVALID_CONTEXT');
  for(const kind of components){const item=ctx.components?.[kind],base='p7_'+kind+'_'+ctx.run.replaceAll('-','').slice(0,16);if(item?.database!==base||item.role!==base+'_app'||item.schema!=='runtime'||!/^[0-9a-f]{64}$/.test(item.password))throw new Error('P7_INVALID_CONTEXT');}
  return ctx;
}
export function loadContext(file){return assertContext(JSON.parse(readFileSync(artifact(file),'utf8')));}
export function url(ctx,kind,admin=false){assertContext(ctx);const c=ctx.components[kind];if(!c)throw new Error('P7_INVALID_COMPONENT');return `postgresql://${admin?'p2_bootstrap':c.role}:${admin?'p2_bootstrap_fixture_only':c.password}@127.0.0.1:55432/${c.database}?schema=runtime&connection_limit=4&pool_timeout=2`;}
export function client(ctx,kind,admin=false){const Client=kind==='clinic'?ClinicClient:kind==='notification'?NotificationClient:PrismaClient;return new Client({datasourceUrl:url(ctx,kind,admin)});}
export const docker=(...args)=>execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml',...args],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
export function sql(database,body){ident(database);return execFileSync('docker',['compose','-f','deploy/phase2/compose.test.yml','exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','p2_bootstrap','-d',database],{input:body,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});}
export async function assertDatabase(db,ctx,kind,{admin=false}={}){
  assertContext(ctx);const c=ctx.components[kind];
  const [i]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role,current_schema() AS schema`;
  assert.deepEqual(i,{db:c.database,role:admin?'p2_bootstrap':c.role,schema:'runtime'},'P7_WRONG_DATABASE_IDENTITY');
  const [m]=await db.$queryRaw`SELECT run,component FROM public.p7_test_marker`;
  assert.deepEqual(m,{run:ctx.run,component:kind==='restore'?'legacy':kind},'P7_WRONG_DATABASE_MARKER');
}
export async function withDatabase(ctx,kind,work,{admin=false}={}){const db=client(ctx,kind,admin);try{await assertDatabase(db,ctx,kind,{admin});return await work(db);}finally{await db.$disconnect();}}
// Hold an independent transaction-scoped lock while component transactions
// commit. The opened_at ledger can be durable before target grants begin.
export async function withCutoverLock(ctx,work){return withDatabase(ctx,'legacy',db=>db.$transaction(async tx=>{await tx.$queryRaw`SELECT pg_advisory_xact_lock(710008)::text`;return work();},{timeout:60000}),{admin:true});}
export function createEnvironment(file){
  assertTestProject();if(process.env.PHASE2_TEST_CONFIRM!=='pet-phase2-p1-test')throw new Error('P7_CONFIRMATION_REQUIRED');
  const path=artifact(file);if(existsSync(path))throw new Error('P7_CONTEXT_EXISTS_NO_OVERWRITE');
  const run=randomUUID(),ctx={version:1,project:'pet-phase2-p1-test',run,components:{}};
  for(const kind of components){const base='p7_'+kind+'_'+run.replaceAll('-','').slice(0,16);ctx.components[kind]={database:base,role:base+'_app',schema:'runtime',password:randomBytes(32).toString('hex')};}
  assertContext(ctx);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(ctx,null,2),{flag:'wx'});
  for(const kind of components.filter(k=>k!=='restore')){
    const c=ctx.components[kind];
    sql('postgres',`CREATE ROLE ${ident(c.role)} LOGIN PASSWORD '${c.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; CREATE DATABASE ${ident(c.database)} OWNER p2_bootstrap; REVOKE ALL ON DATABASE ${ident(c.database)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${ident(c.database)} TO ${ident(c.role)};`);
    sql(c.database,`REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE SCHEMA runtime AUTHORIZATION p2_bootstrap; GRANT USAGE ON SCHEMA runtime TO ${ident(c.role)}; CREATE TABLE public.p7_test_marker(run text PRIMARY KEY,component text NOT NULL); INSERT INTO public.p7_test_marker VALUES ('${run}','${kind}'); GRANT SELECT ON public.p7_test_marker TO ${ident(c.role)}; CREATE TABLE public.p7_import_journal(snapshot_hash text PRIMARY KEY,completed_at timestamptz NOT NULL DEFAULT now());`);
    const schema=kind==='clinic'?'services/clinic/prisma/schema.prisma':kind==='notification'?'services/notification/prisma/schema.prisma':'backend/prisma/schema.prisma';
    execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--schema',schema],{env:{...process.env,DATABASE_URL:url(ctx,kind,true)},stdio:'pipe',timeout:60000});
    sql(c.database,`GRANT SELECT ON ALL TABLES IN SCHEMA runtime TO ${ident(c.role)};`);
  }
  sql(ctx.components.legacy.database,`CREATE TABLE public.p7_cutover(id integer PRIMARY KEY CHECK(id=1),state text NOT NULL CHECK(state IN ('LEGACY','FROZEN','IMPORTED','TARGET_OPEN','TARGET_PAUSED')),snapshot_hash text,opened_at timestamptz); INSERT INTO public.p7_cutover VALUES (1,'LEGACY',NULL,NULL); GRANT SELECT ON public.p7_cutover TO ${ident(ctx.components.legacy.role)}; GRANT INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA runtime TO ${ident(ctx.components.legacy.role)}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA runtime TO ${ident(ctx.components.legacy.role)};`);
  return ctx;
}
export async function backupAndRestore(ctx){
  assertTestProject();return withDatabase(ctx,'legacy',async db=>{
    const [gate]=await db.$queryRaw`SELECT state FROM public.p7_cutover WHERE id=1`;if(gate.state!=='FROZEN')throw new Error('P7_FROZEN_BACKUP_REQUIRED');
    const source=ctx.components.legacy,restore=ctx.components.restore,inside='/tmp/p7-'+ctx.run+'.dump',out=artifact('test-results/phase2/p7-'+ctx.run+'/legacy.dump');
    if(existsSync(out))throw new Error('P7_BACKUP_EXISTS_NO_OVERWRITE');mkdirSync(resolve(out,'..'),{recursive:true});
    docker('exec','-T','postgres','pg_dump','-U','p2_bootstrap','-d',source.database,'-Fc','--no-acl','-f',inside);
    const container=docker('ps','-q','postgres').trim();execFileSync('docker',['cp',container+':'+inside,out],{stdio:'pipe'});
    sql('postgres',`CREATE ROLE ${ident(restore.role)} LOGIN PASSWORD '${restore.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; CREATE DATABASE ${ident(restore.database)} OWNER p2_bootstrap; REVOKE ALL ON DATABASE ${ident(restore.database)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${ident(restore.database)} TO ${ident(restore.role)};`);
    // Restore only a fresh named DB: never --clean, --create or overwrite.
    docker('exec','-T','postgres','pg_restore','-U','p2_bootstrap','-d',restore.database,'--no-owner','--no-acl','--exit-on-error','--single-transaction',inside);
    sql(restore.database,`GRANT USAGE ON SCHEMA runtime TO ${ident(restore.role)}; GRANT SELECT ON ALL TABLES IN SCHEMA runtime TO ${ident(restore.role)}; GRANT SELECT ON public.p7_test_marker,public.p7_cutover TO ${ident(restore.role)};`);
    return {file:relative(resolve('.'),out).replaceAll('\\','/'),bytes:readFileSync(out).length};
  });
}
