import type { PrismaClient } from './generated/client/index.js';
import { createRuntime, integer, type Actor } from '@nipopeto/runtime';
export const clinicRuntime=(db:PrismaClient,verify:(token:string)=>Actor)=>createRuntime({service:'clinic',verify,probe:async()=>db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '1500ms'");
  const migrations=await tx.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name='20261011000900_billing_terminal' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  if(Number(migrations[0]?.count)!==1)throw new Error('MIGRATION_REQUIRED');
  const outbox=await tx.$queryRaw<{pending:bigint;age:number;retries:bigint}[]>`SELECT count(*) AS pending,COALESCE(EXTRACT(EPOCH FROM(now()-min("createdAt"))),0)::float AS age,COALESCE(sum(attempts),0)::bigint AS retries FROM (SELECT "createdAt",attempts FROM "OutboxEvent" WHERE "publishedAt" IS NULL ORDER BY "createdAt",id LIMIT ${integer('OUTBOX_HARD_LIMIT',20000)+1}) q`;
  const billing=await tx.$queryRaw<{pending:bigint;age:number}[]>`SELECT count(*) AS pending,COALESCE(EXTRACT(EPOCH FROM(now()-min("createdAt"))),0)::float AS age FROM "AppointmentReservation" WHERE state='HELD'`;
  const waits=await tx.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock'`;
  return{pending:Number(outbox[0]!.pending),outboxAgeSeconds:outbox[0]!.age,outboxRetries:Number(outbox[0]!.retries),billingPending:Number(billing[0]!.pending),billingAgeSeconds:billing[0]!.age,dbLockWaits:Number(waits[0]!.count)};
},{maxWait:1500,timeout:2500})});
