import type { PrismaClient } from './generated/client/index.js';
import { createRuntime, type Actor } from '@nipopeto/runtime';
export const notificationRuntime=(db:PrismaClient,verify:(token:string)=>Actor)=>createRuntime({service:'notification',verify,probe:async()=>db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '1500ms'");
  const migrations=await tx.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name='20261011000500_manual_send_dedup' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  if(Number(migrations[0]?.count)!==1)throw new Error('MIGRATION_REQUIRED');
  await tx.inboxEvent.count();await tx.notification.count();await tx.requestDedup.count();
  const waits=await tx.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock'`;
  return{pending:0,outboxAgeSeconds:0,outboxRetries:0,billingPending:0,billingAgeSeconds:0,dbLockWaits:Number(waits[0]!.count)};
},{maxWait:1500,timeout:2500})});
