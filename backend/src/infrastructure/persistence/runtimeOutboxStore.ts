import type { PrismaClient } from '@prisma/client';
import type { OutboxStore } from '../../phase2/relay.js';

// Core runtime adapter uses Core's own full schema/client. Generated Prisma
// delegates are not cast or passed between independent schemas/services.
export class RuntimeOutboxStore implements OutboxStore {
  constructor(private readonly db: PrismaClient) {}
  claim(leaseOwner: string, scope: string | null) {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      return tx.outboxEvent.update({ where: { id: rows[0].id }, data: { leaseOwner, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
    });
  }
  async markPublished(id: string, leaseOwner: string) {
    await this.db.outboxEvent.updateMany({ where: { id, leaseOwner, leaseUntil: { gt: new Date() } }, data: { publishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null } });
  }
  async retry(id: string, leaseOwner: string, nextAttemptAt: Date) {
    await this.db.outboxEvent.updateMany({ where: { id, leaseOwner }, data: { leaseOwner: null, leaseUntil: null, nextAttemptAt, lastErrorCode: 'DELIVERY_UNCONFIRMED' } });
  }
}
