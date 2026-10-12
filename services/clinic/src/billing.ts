import type { PrismaClient, Prisma } from './generated/client/index.js';
import type { CoreState, ReservationSnapshot } from '@nipopeto/contracts';
export class ReservationConflict extends Error {}
export class ClinicBilling {
  constructor(private readonly db: PrismaClient) {}
  async prepare(operationId: string, appointmentId: string, revision: number, afterLock?: () => Promise<void>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ProofAppointment" WHERE id = ${appointmentId} FOR UPDATE`;
      await afterLock?.();
      const existing = await tx.billingReservation.findUnique({ where: { operationId } });
      if (existing) {
        if (existing.appointmentId !== appointmentId || existing.revisionAtPrepare !== revision || existing.state === 'RELEASED') throw new ReservationConflict('OPERATION_REUSE');
        return existing.snapshot as unknown as ReservationSnapshot;
      }
      const appointment = await tx.proofAppointment.findUniqueOrThrow({ where: { id: appointmentId } });
      if (appointment.status !== 'completed' || appointment.revision !== revision) throw new ReservationConflict('SOURCE_CONFLICT');
      if (await tx.billingReservation.findFirst({ where: { appointmentId, state: { in: ['HELD', 'INVOICED'] } } })) throw new ReservationConflict('RESERVED');
      const snapshot: ReservationSnapshot = { appointmentId, revision, ownerId: appointment.ownerId, petId: appointment.petId, type: appointment.type };
      await tx.billingReservation.create({ data: { operationId, appointmentId, revisionAtPrepare: revision, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
      return snapshot;
    });
  }
  async undo(appointmentId: string, expectedRevision: number, afterLock?: () => Promise<void>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ProofAppointment" WHERE id = ${appointmentId} FOR UPDATE`;
      await afterLock?.();
      const appointment = await tx.proofAppointment.findUniqueOrThrow({ where: { id: appointmentId } });
      if (appointment.status !== 'completed' || appointment.revision !== expectedRevision || await tx.billingReservation.findFirst({ where: { appointmentId, state: { in: ['HELD', 'INVOICED'] } } })) throw new ReservationConflict('UNDO_CONFLICT');
      return tx.proofAppointment.update({ where: { id: appointmentId }, data: { status: 'confirmed', revision: { increment: 1 } } });
    });
  }
  // Called only with authenticated Core terminal evidence. Never release on timeout.
  async reconcile(operationId: string, core: { state: CoreState; invoiceId?: string }) {
    return this.db.$transaction(async tx => {
      const r = await tx.billingReservation.findUniqueOrThrow({ where: { operationId } });
      await tx.$queryRaw`SELECT id FROM "ProofAppointment" WHERE id = ${r.appointmentId} FOR UPDATE`;
      const current = await tx.billingReservation.findUniqueOrThrow({ where: { operationId } });
      if (core.state === 'PREPARING') return current;
      const state = core.state === 'COMMITTED' ? 'INVOICED' : 'RELEASED';
      if (state === 'INVOICED' && !core.invoiceId) throw new ReservationConflict('INVOICE_REQUIRED');
      if (current.state !== 'HELD') {
        if (current.state !== state || (state === 'INVOICED' && current.invoiceId !== core.invoiceId)) throw new ReservationConflict('TERMINAL_CONFLICT');
        return current;
      }
      return tx.billingReservation.update({ where: { operationId }, data: { state, invoiceId: core.invoiceId } });
    });
  }
}
