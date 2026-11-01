import { serviceOrigin, traceHeaders } from '@nipopeto/runtime';
import type { BillingSourceSnapshot } from '@nipopeto/contracts';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import type { BillingOperationRecord, BillingRemote } from '../../application/ports/appointmentBilling.js';
import { signToken } from '../../lib/token.js';

export class ClinicBillingRemote implements BillingRemote {
  constructor(
    private readonly origin: URL,
    private readonly credential: string,
    private readonly timeout = 1800,
  ) {
    serviceOrigin(origin, 'INVALID_BILLING_REMOTE_CONFIGURATION');
    if (
      credential.length < 32 ||
      credential.length > 512 ||
      !Number.isInteger(timeout) ||
      timeout < 100 ||
      timeout > 5000
    )
      throw new Error('INVALID_BILLING_REMOTE_CONFIGURATION');
  }
  private async call(path: string, method: string, actor?: Actor, body?: unknown) {
    try {
      const res = await fetch(new URL(path, this.origin), {
        method,
        headers: {
          ...traceHeaders(),
          'X-Service-Token': this.credential,
          ...(actor ? { Authorization: 'Bearer ' + signToken(actor.sub, actor.role) } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
      });
      if ([403, 404, 409, 422].includes(res.status))
        throw new BusinessError(res.status as 403 | 404 | 409 | 422, 'Clinic rejected the billing source.');
      if (res.status !== 200) throw new Error();
      return await res.json();
    } catch (e) {
      if (e instanceof BusinessError) throw e;
      throw new BusinessError(503, 'Clinic billing temporarily unavailable.');
    }
  }
  private snapshot(value: any, id: string): BillingSourceSnapshot {
    const s = value?.snapshot;
    if (
      !s ||
      s.appointmentId !== id ||
      !Number.isSafeInteger(s.revision) ||
      s.revision < 0 ||
      !['ownerId', 'petId', 'type', 'serviceName', 'clinicName', 'date', 'time'].every(
        k => typeof s[k] === 'string' && s[k].length > 0 && s[k].length <= 2000,
      ) ||
      !/^\d{4}-\d\d-\d\d$/.test(s.date) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ||
      Object.keys(s).some(
        k =>
          ![
            'appointmentId',
            'revision',
            'ownerId',
            'petId',
            'type',
            'serviceName',
            'clinicName',
            'date',
            'time',
          ].includes(k),
      )
    )
      throw new BusinessError(503, 'Invalid Clinic billing snapshot.');
    return s;
  }
  async source(id: string, actor: Actor) {
    return this.snapshot(await this.call('/internal/billing-sources/' + encodeURIComponent(id), 'GET', actor), id);
  }
  async prepare(op: BillingOperationRecord, actor: Actor) {
    const s = this.snapshot(
      await this.call('/internal/billing-reservations/' + encodeURIComponent(op.id), 'PUT', actor, {
        appointmentId: op.appointmentId,
        expectedRevision: op.expectedRevision,
      }),
      op.appointmentId,
    );
    if (s.revision !== op.expectedRevision) throw new BusinessError(503, 'Reservation revision mismatch.');
    return s;
  }
  async finalize(op: BillingOperationRecord) {
    await this.call(
      '/internal/billing-reservations/' +
        encodeURIComponent(op.id) +
        (op.state === 'COMMITTED' ? '/commit' : '/release'),
      'POST',
      undefined,
      {},
    );
  }
}
