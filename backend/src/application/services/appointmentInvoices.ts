import { createHash, randomUUID } from 'node:crypto';
import type { BillingSourceSnapshot, Envelope } from '@nipopeto/contracts';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import { authorize } from '../../domain/authorization.js';
import { charges, fees, type Fees } from '../../domain/billing/charges.js';
import { isPending, terminalState } from '../../domain/billing/operation.js';
import type {
  BillingInvoice,
  BillingOperationRecord,
  BillingOperationStore,
  BillingRemote,
} from '../ports/appointmentBilling.js';

export class AppointmentInvoices {
  // `present` shapes the invoice of a finished operation for the wire. It goes away once the routes map the invoice themselves.
  constructor(
    private readonly store: BillingOperationStore,
    private readonly remote: BillingRemote,
    private readonly present: (invoice: BillingInvoice) => unknown,
  ) {}
  async actor(actor: Actor) {
    const role = await this.store.actorRole(actor.sub);
    if (role === null || role !== actor.role) throw new BusinessError(403, 'Current actor role is required.');
  }
  async begin(actor: Actor, input: Record<string, unknown>, key: unknown, self = false) {
    await this.actor(actor);
    authorize(actor, self ? 'billing.self-service' : 'billing.manage');
    if (typeof key !== 'string' || !key.trim() || key !== key.trim() || key.length > 128)
      throw new BusinessError(422, 'Idempotency-Key is required (maximum 128 characters).');
    const payload = fees(input, self),
      operationType = self ? 'invoice.checkout' : 'invoice.create';
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    // When the insert wrote nothing, the row found is another request's: these checks look at the same row as before.
    const op = await this.store.insertAndRead({
      id: randomUUID(),
      actorId: actor.sub,
      actorRole: actor.role,
      operationType,
      idempotencyKey: key,
      requestHash: hash,
      appointmentId: payload.relatedId,
      payload,
      expectedRevision: payload.expectedRevision ?? null,
    });
    if (!op) throw new BusinessError(409, 'Appointment billing is already pending.');
    if (op.requestHash !== hash) throw new BusinessError(409, 'Request key was used with different charges.');
    return op;
  }
  async read(id: string) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new BusinessError(422, 'Invalid operation ID.');
    const operation = await this.store.find(id);
    if (!operation) throw new BusinessError(404, 'Operation not found.');
    return operation;
  }
  async terminal(
    id: string,
    action: 'commit' | 'abort',
    snapshot?: BillingSourceSnapshot,
    error?: { status: number; code: string },
    fault?: () => void,
    afterLock?: () => Promise<void>,
  ) {
    return this.store.terminal(
      id,
      async (tx, op) => {
        if (!isPending(op.state)) return op;
        let invoiceId: string | undefined;
        let existingCheckout = false;
        if (action === 'commit') {
          if (!snapshot || snapshot.appointmentId !== op.appointmentId || snapshot.revision !== op.expectedRevision)
            throw new BusinessError(409, 'A prepared reservation is required.');
          const old = op.operationType === 'invoice.checkout' ? await tx.invoiceForAppointment(op.appointmentId) : null;
          if (old && old.ownerId !== op.actorId) throw new BusinessError(404, 'Billing source not found.');
          if (old) {
            invoiceId = old.id;
            existingCheckout = true;
          } else {
            const c = charges(op.payload as unknown as Fees, snapshot, op.operationType === 'invoice.checkout');
            const { items, ...data } = c;
            const invoice = await tx.createInvoice({
              ...data,
              id: randomUUID(),
              invoiceCode: 'INV-' + randomUUID(),
              type: 'appointment',
              ownerId: snapshot.ownerId,
              petId: snapshot.petId,
              appointmentId: op.appointmentId,
              sourceSnapshot: snapshot,
              items,
            });
            invoiceId = invoice.id;
            await tx.notify({
              recipientOwnerId: snapshot.ownerId,
              recipientRole: 'owner',
              type: 'invoice_requested',
              title: 'Yêu cầu thanh toán',
              message: `Hóa đơn ${invoice.invoiceCode}: ${c.totalAmount.toLocaleString('vi-VN')} VND. Vui lòng kiểm tra các khoản phí.`,
              actionUrl: '/owner/billing',
            });
          }
        }
        const updated = await tx.update(id, {
          state: terminalState(action),
          invoiceId: invoiceId ?? null,
          snapshot,
          terminalAt: new Date(),
          ...(existingCheckout ? { finalizedAt: new Date() } : {}),
          errorStatus: error?.status,
          errorCode: error?.code,
        });
        if (existingCheckout) return updated; // Baseline checkout returns an already-issued invoice; no new reservation/event/notice.
        const event: Envelope = {
          eventId: randomUUID(),
          eventType: action === 'commit' ? 'billing.invoice-issued.v1' : 'billing.operation-aborted.v1',
          schemaVersion: 1,
          producer: 'core',
          aggregateType: 'billing-operation',
          aggregateId: id,
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          correlationId: id,
          payload: { operationId: id, appointmentId: op.appointmentId, ...(invoiceId ? { invoiceId } : {}) },
        };
        await tx.publish(event);
        fault?.();
        return updated;
      },
      afterLock,
    );
  }
  async resume(id: string) {
    let op = await this.read(id);
    if (!isPending(op.state)) return op;
    try {
      const actor: Actor = { sub: op.actorId, role: op.actorRole as Actor['role'] };
      await this.actor(actor);
      if (op.operationType === 'invoice.checkout') {
        const old = await this.store.invoiceForAppointment(op.appointmentId);
        if (old) {
          if (old.ownerId !== actor.sub) throw new BusinessError(404, 'Billing source not found.');
          if (!old.sourceSnapshot) throw new BusinessError(503, 'Historical invoice snapshot requires migration.');
          const s = old.sourceSnapshot as unknown as BillingSourceSnapshot;
          if (op.expectedRevision === null) await this.store.setExpectedRevision(id, s.revision);
          return this.terminal(id, 'commit', s);
        }
      }
      if (op.expectedRevision === null) {
        const source = await this.remote.source(op.appointmentId, actor);
        await this.store.setExpectedRevision(id, source.revision);
        op = await this.read(id);
        if (!isPending(op.state)) return op;
      }
      const snapshot = await this.remote.prepare(op, actor);
      const { pet, owner } = await this.store.ownerFacts(snapshot);
      if (
        !pet ||
        pet.ownerId !== snapshot.ownerId ||
        owner?.role !== 'owner' ||
        (actor.role === 'owner' && snapshot.ownerId !== actor.sub)
      )
        throw new BusinessError(404, 'Billing source owner is unavailable.');
      return await this.terminal(id, 'commit', snapshot);
    } catch (e) {
      if (e instanceof BusinessError && e.status !== 503)
        return this.terminal(id, 'abort', undefined, { status: e.status, code: e.message });
      if (this.store.isUniqueViolation(e))
        return this.terminal(id, 'abort', undefined, { status: 409, code: 'Appointment already has an invoice.' });
      // A network/DB error is unknown. Retain operation and reservation for retry.
      return this.read(id);
    }
  }
  async result(op: BillingOperationRecord) {
    if (op.state === 'COMMITTED') {
      const invoice = await this.store.invoiceWithItems(op.invoiceId!);
      return {
        operationId: op.id,
        status: 'succeeded' as const,
        invoiceId: invoice.id,
        invoice: this.present(invoice),
      };
    }
    if (op.state === 'ABORTED')
      return {
        operationId: op.id,
        status: 'failed' as const,
        error: op.errorCode ?? 'Operation aborted.',
        errorStatus: op.errorStatus ?? 409,
      };
    return { operationId: op.id, status: 'pending' as const };
  }
  async reconcileOnce(workerId: string, limit = 8, operationId?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('INVALID_RECONCILE_BATCH');
    const ids = await this.store.claimDue(workerId, limit, operationId);
    for (const { id } of ids) {
      try {
        const op = await this.resume(id);
        if (!isPending(op.state)) {
          await this.remote.finalize(op);
          await this.store.markFinalized(id, workerId);
        }
      } catch {
        /* Safe retry metadata only; never print URLs, actor tokens or snapshots. */
      } finally {
        const op = await this.read(id);
        await this.store.release(
          id,
          workerId,
          new Date(Date.now() + Math.min(60000, 500 * 2 ** Math.min(op.attempts, 7))),
        );
      }
    }
    return ids.length;
  }
}
