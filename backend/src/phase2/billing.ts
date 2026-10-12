import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '../generated/phase2-core/index.js';
import type { Envelope, ReservationSnapshot } from '@nipopeto/contracts';
export class BillingConflict extends Error {}
type Input = { actorId: string; idempotencyKey: string; appointmentId: string; expectedRevision: number; amount: number };
export class CoreBilling {
  constructor(private readonly db: PrismaClient) {}
  async begin(input: Input) {
    if (!input.actorId || !input.idempotencyKey || !Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > 2147483647) throw new BillingConflict('INVALID_INPUT');
    const requestHash = createHash('sha256').update(JSON.stringify([input.appointmentId, input.expectedRevision, input.amount])).digest('hex');
    return this.db.$transaction(async tx => {
      // Both key uniqueness and the active-source partial index can arbitrate
      // concurrent retries. Target all constraints, then distinguish durable
      // key replay from another operation holding this appointment.
      await tx.$executeRaw`INSERT INTO "BillingOperation" (id,"actorId","idempotencyKey","requestHash","appointmentId","expectedRevision",amount,state,"createdAt")
        VALUES (${randomUUID()},${input.actorId},${input.idempotencyKey},${requestHash},${input.appointmentId},${input.expectedRevision},${input.amount},'PREPARING',now()) ON CONFLICT DO NOTHING`;
      const operation = await tx.billingOperation.findUnique({ where: { actorId_idempotencyKey: { actorId: input.actorId, idempotencyKey: input.idempotencyKey } } });
      if(!operation)throw new BillingConflict('SOURCE_BUSY');
      if (operation.requestHash !== requestHash) throw new BillingConflict('KEY_REUSE');
      return operation;
    });
  }
  async terminal(id: string, action: 'commit' | 'abort', snapshot?: ReservationSnapshot, fault?: () => void, afterLock?: () => Promise<void>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "BillingOperation" WHERE id = ${id} FOR UPDATE`;
      await afterLock?.();
      const operation = await tx.billingOperation.findUniqueOrThrow({ where: { id } });
      if (operation.state !== 'PREPARING') return { operation, invoice: await tx.proofInvoice.findUnique({ where: { operationId: id } }) };
      let invoice = null;
      if (action === 'commit') {
        if (!snapshot || snapshot.appointmentId !== operation.appointmentId || snapshot.revision !== operation.expectedRevision) throw new BillingConflict('RESERVATION_REQUIRED');
        invoice = await tx.proofInvoice.create({ data: { id: randomUUID(), operationId: id, appointmentId: operation.appointmentId, amount: operation.amount, sourceSnapshot: snapshot as unknown as Prisma.InputJsonValue } });
      }
      const state = action === 'commit' ? 'COMMITTED' : 'ABORTED';
      const updated = await tx.billingOperation.update({ where: { id }, data: { state } });
      const envelope: Envelope = { eventId: randomUUID(), eventType: action === 'commit' ? 'billing.invoice-issued.v1' : 'billing.operation-aborted.v1', schemaVersion: 1, producer: 'core', aggregateType: 'billing-operation', aggregateId: id, aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: id, payload: { operationId: id, ...(invoice ? { invoiceId: invoice.id } : {}) } };
      await tx.outboxEvent.create({ data: { id: envelope.eventId, envelope: envelope as unknown as Prisma.InputJsonValue } });
      fault?.(); // test-only callback; no public fault endpoint
      return { operation: updated, invoice };
    });
  }
}
