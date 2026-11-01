import type { Prisma, PrismaClient } from '@prisma/client';
import type { BillingSourceSnapshot } from '@nipopeto/contracts';
import type {
  BillingOperationRecord,
  BillingOperationRow,
  BillingOperationStore,
  BillingTerminalTx,
} from '../../application/ports/appointmentBilling.js';
import { writeNotification } from './notificationOutbox.js';

export class PrismaBillingOperationStore implements BillingOperationStore {
  constructor(private readonly db: PrismaClient) {}
  async actorRole(id: string) {
    const current = await this.db.user.findUnique({ where: { id }, select: { role: true } });
    return current ? current.role : null;
  }
  insertAndRead(row: BillingOperationRow) {
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "AppointmentBillingOperation" (id,"actorId","actorRole","operationType","idempotencyKey","requestHash","appointmentId",payload,"expectedRevision","updatedAt") VALUES (${row.id},${row.actorId},${row.actorRole},${row.operationType},${row.idempotencyKey},${row.requestHash},${row.appointmentId},${JSON.stringify(row.payload)}::jsonb,${row.expectedRevision},now()) ON CONFLICT DO NOTHING`;
      return tx.appointmentBillingOperation.findUnique({
        where: {
          actorId_operationType_idempotencyKey: {
            actorId: row.actorId,
            operationType: row.operationType,
            idempotencyKey: row.idempotencyKey,
          },
        },
      });
    });
  }
  find(id: string) {
    return this.db.appointmentBillingOperation.findUnique({ where: { id } });
  }
  invoiceForAppointment(appointmentId: string) {
    return this.db.invoice.findUnique({ where: { appointmentId } });
  }
  invoiceWithItems(id: string) {
    return this.db.invoice.findUniqueOrThrow({ where: { id }, include: { items: true } });
  }
  async setExpectedRevision(id: string, revision: number) {
    await this.db.appointmentBillingOperation.updateMany({
      where: { id, state: 'PREPARING', expectedRevision: null },
      data: { expectedRevision: revision },
    });
  }
  async ownerFacts(snapshot: BillingSourceSnapshot) {
    const pet = await this.db.pet.findUnique({ where: { id: snapshot.petId }, select: { ownerId: true } });
    const owner = await this.db.user.findUnique({ where: { id: snapshot.ownerId }, select: { role: true } });
    return { pet, owner };
  }
  terminal<T>(
    id: string,
    work: (tx: BillingTerminalTx, op: BillingOperationRecord) => Promise<T>,
    afterLock?: () => Promise<void>,
  ) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "AppointmentBillingOperation" WHERE id=${id} FOR UPDATE`;
      await afterLock?.();
      const op = await tx.appointmentBillingOperation.findUniqueOrThrow({ where: { id } });
      return work(
        {
          invoiceForAppointment: appointmentId => tx.invoice.findUnique({ where: { appointmentId } }),
          createInvoice: data =>
            tx.invoice.create({
              data: {
                ...data,
                sourceSnapshot: data.sourceSnapshot as unknown as Prisma.InputJsonValue,
                items: { create: data.items },
              },
              include: { items: true },
            }),
          notify: async draft => {
            await writeNotification(tx, draft);
          },
          update: (opId, data) =>
            tx.appointmentBillingOperation.update({
              where: { id: opId },
              data: {
                ...data,
                snapshot: data.snapshot ? (data.snapshot as unknown as Prisma.InputJsonValue) : undefined,
              },
            }),
          publish: async event => {
            await tx.outboxEvent.create({
              data: { id: event.eventId, envelope: event as unknown as Prisma.InputJsonValue },
            });
          },
        },
        op,
      );
    });
  }
  async claimDue(workerId: string, limit: number, operationId?: string) {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "AppointmentBillingOperation" WHERE (${operationId ?? null}::text IS NULL OR id=${operationId ?? null}) AND "finalizedAt" IS NULL AND "nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for (const r of rows)
        await tx.appointmentBillingOperation.update({
          where: { id: r.id },
          data: { leaseOwner: workerId, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } },
        });
      return rows;
    });
  }
  async markFinalized(id: string, workerId: string) {
    await this.db.appointmentBillingOperation.updateMany({
      where: { id, leaseOwner: workerId },
      data: { finalizedAt: new Date() },
    });
  }
  async release(id: string, workerId: string, nextAttemptAt: Date) {
    await this.db.appointmentBillingOperation.updateMany({
      where: { id, leaseOwner: workerId },
      data: { leaseOwner: null, leaseUntil: null, nextAttemptAt },
    });
  }
  isUniqueViolation(error: unknown) {
    return (error as { code?: string }).code === 'P2002';
  }
}
