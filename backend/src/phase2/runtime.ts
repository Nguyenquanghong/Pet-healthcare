import type { PrismaClient } from '@prisma/client';
import { createRuntime, integer } from '@nipopeto/runtime';
import { verifyToken } from '../lib/token.js';
import { hashAdmission } from '../lib/password.js';
export const coreRuntime = (db: PrismaClient) =>
  createRuntime({
    service: 'core',
    verify: verifyToken,
    extras: () =>
      Object.fromEntries(
        Object.entries(hashAdmission.stats).map(([k, v]) => [
          'hash_' + k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()),
          v,
        ]),
      ),
    probe: async () =>
      db.$transaction(
        async tx => {
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '1500ms'");
          const migrations = await tx.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name='20261011000800_appointment_billing' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
          if (Number(migrations[0]?.count) !== 1) throw new Error('MIGRATION_REQUIRED');
          const outbox = await tx.$queryRaw<
            { pending: bigint; age: number; retries: bigint }[]
          >`SELECT count(*) AS pending,COALESCE(EXTRACT(EPOCH FROM(now()-min("createdAt"))),0)::float AS age,COALESCE(sum(attempts),0)::bigint AS retries FROM (SELECT "createdAt",attempts FROM "OutboxEvent" WHERE "publishedAt" IS NULL ORDER BY "createdAt",id LIMIT ${integer('OUTBOX_HARD_LIMIT', 20000) + 1}) q`;
          const billing = await tx.$queryRaw<
            { pending: bigint; age: number }[]
          >`SELECT count(*) AS pending,COALESCE(EXTRACT(EPOCH FROM(now()-min("createdAt"))),0)::float AS age FROM "AppointmentBillingOperation" WHERE state='PREPARING'`;
          const waits = await tx.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock'`;
          return {
            pending: Number(outbox[0]!.pending),
            outboxAgeSeconds: outbox[0]!.age,
            outboxRetries: Number(outbox[0]!.retries),
            billingPending: Number(billing[0]!.pending),
            billingAgeSeconds: billing[0]!.age,
            dbLockWaits: Number(waits[0]!.count),
          };
        },
        { maxWait: 1500, timeout: 2500 },
      ),
  });
