import {assertContext,withDatabase,withCutoverLock,ident} from './p7-environment.mjs';
import {catalogs,targets,sourceNames} from './p7-manifest.mjs';
import {validateMigration,assertFrozenSource} from './p7-migration.mjs';

const targetKinds=['core','clinic','notification'];
function runtimeTables(kind){const names=[...targets[kind],...(kind==='clinic'?['OutboxEvent','RequestDedup']:kind==='notification'?['RequestDedup']:[])];return [...new Set(names.map(n=>catalogs[kind][n].table))];}
export async function targetPermissions(ctx,write){
  for(const kind of targetKinds)await withDatabase(ctx,kind,db=>db.$transaction(async tx=>{
    const role=ident(ctx.components[kind].role);
    await tx.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA runtime FROM ${role}`);
    await tx.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA runtime FROM ${role}`);
    const tables=runtimeTables(kind).map(t=>'runtime.'+ident(t)).concat('runtime."_prisma_migrations"');
    await tx.$executeRawUnsafe(`GRANT SELECT ON ${tables.join(',')} TO ${role}`);
    if(write){await tx.$executeRawUnsafe(`GRANT INSERT,UPDATE,DELETE ON ${runtimeTables(kind).map(t=>'runtime.'+ident(t)).join(',')} TO ${role}`);if(kind==='core')await tx.$executeRawUnsafe(`GRANT USAGE,SELECT ON SEQUENCE runtime.invoice_transfer_code_seq TO ${role}`);}
  }),{admin:true});
}
export async function cutoverState(ctx){return withDatabase(ctx,'legacy',async db=>(await db.$queryRaw`SELECT state,snapshot_hash,opened_at FROM public.p7_cutover WHERE id=1`)[0]);}
// Gateway maintenance/drain must precede these operations. The database fence
// waits for all earlier business transactions and also blocks a bypassing writer.
async function freezeLegacyLocked(ctx){
  assertContext(ctx);return withDatabase(ctx,'legacy',db=>db.$transaction(async tx=>{
    const [g]=await tx.$queryRaw`SELECT state,opened_at FROM public.p7_cutover WHERE id=1 FOR UPDATE`;
    if(g.state!=='LEGACY'||g.opened_at!==null)throw new Error('P7_LEGACY_FREEZE_STATE');
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
    await tx.$executeRawUnsafe(`LOCK TABLE ${sourceNames.map(n=>'runtime.'+ident(catalogs.source[n].table)).join(',')} IN ACCESS EXCLUSIVE MODE`);
    const role=ident(ctx.components.legacy.role);await tx.$executeRawUnsafe(`REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA runtime FROM ${role}`);await tx.$executeRawUnsafe(`REVOKE USAGE ON ALL SEQUENCES IN SCHEMA runtime FROM ${role}`);
    await tx.$executeRaw`UPDATE public.p7_cutover SET state='FROZEN' WHERE id=1`;
  },{timeout:15000}),{admin:true});
}
async function rollbackBeforeOpenLocked(ctx){
  return withDatabase(ctx,'legacy',db=>db.$transaction(async tx=>{
    const [g]=await tx.$queryRaw`SELECT state,opened_at FROM public.p7_cutover WHERE id=1 FOR UPDATE`;
    if(!['FROZEN','IMPORTED'].includes(g.state)||g.opened_at!==null)throw new Error('P7_ROLLBACK_AFTER_OPEN_REQUIRES_FORWARD_FIX');
    await targetPermissions(ctx,false);const role=ident(ctx.components.legacy.role);
    await tx.$executeRawUnsafe(`GRANT INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA runtime TO ${role}`);await tx.$executeRawUnsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA runtime TO ${role}`);
    await tx.$executeRaw`UPDATE public.p7_cutover SET state='LEGACY' WHERE id=1`;
  },{timeout:20000}),{admin:true});
}
async function openTargetLocked(ctx,snapshot){
  await assertFrozenSource(ctx,snapshot);await validateMigration(ctx,snapshot);
  await withDatabase(ctx,'legacy',db=>db.$transaction(async tx=>{
    const [g]=await tx.$queryRaw`SELECT state,snapshot_hash FROM public.p7_cutover WHERE id=1 FOR UPDATE`;
    if(g.state!=='IMPORTED'||g.snapshot_hash!==snapshot.sha256)throw new Error('P7_VALIDATED_IMPORT_REQUIRED');
    // Record irreversible possibility FIRST. A crash while grants are partial
    // leaves maintenance/forward-fix; it never grants the old writer again.
    await tx.$executeRaw`UPDATE public.p7_cutover SET state='TARGET_OPEN',opened_at=now() WHERE id=1`;
  }),{admin:true});
  await targetPermissions(ctx,true);
}
async function pauseTargetLocked(ctx){
  const gate=await cutoverState(ctx);if(!['TARGET_OPEN','TARGET_PAUSED'].includes(gate.state))throw new Error('P7_TARGET_PAUSE_STATE');
  await targetPermissions(ctx,false);await withDatabase(ctx,'legacy',db=>db.$executeRaw`UPDATE public.p7_cutover SET state='TARGET_PAUSED' WHERE id=1 AND opened_at IS NOT NULL`,{admin:true});
}
async function forwardFixLocked(ctx){
  const gate=await cutoverState(ctx);if(!['TARGET_OPEN','TARGET_PAUSED'].includes(gate.state)||!gate.opened_at)throw new Error('P7_FORWARD_FIX_STATE');
  // Data is retained. Caller drains/restarts only target runtimes, validates
  // current data, and keeps gateway maintenance until grants are complete.
  await targetPermissions(ctx,true);await withDatabase(ctx,'legacy',db=>db.$executeRaw`UPDATE public.p7_cutover SET state='TARGET_OPEN' WHERE id=1 AND opened_at IS NOT NULL`,{admin:true});
}
export const freezeLegacy=ctx=>withCutoverLock(ctx,()=>freezeLegacyLocked(ctx));
export const rollbackBeforeOpen=ctx=>withCutoverLock(ctx,()=>rollbackBeforeOpenLocked(ctx));
export const openTarget=(ctx,snapshot)=>withCutoverLock(ctx,()=>openTargetLocked(ctx,snapshot));
export const pauseTarget=ctx=>withCutoverLock(ctx,()=>pauseTargetLocked(ctx));
export const forwardFix=ctx=>withCutoverLock(ctx,()=>forwardFixLocked(ctx));
