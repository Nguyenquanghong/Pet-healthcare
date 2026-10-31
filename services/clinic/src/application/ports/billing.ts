import type { BillingSourceSnapshot, CoreState } from '@nipopeto/contracts';
import type { Actor } from '../../domain/auth.js';

export type ReservationRecord = {
  operationId: string;
  appointmentId: string;
  state: string;
  invoiceId: string | null;
  snapshot: unknown;
};
// What the internal billing API asks of Clinic's reservation store; a missing reservation is null, the 404 is HTTP's.
export interface ReservationBilling {
  source(appointmentId: string, actor: Actor): Promise<BillingSourceSnapshot>;
  prepare(operationId: string, appointmentId: string, revision: number, actor: Actor): Promise<BillingSourceSnapshot>;
  reconcile(
    operationId: string,
    evidence: { state: CoreState; appointmentId: string; invoiceId?: string | null },
  ): Promise<unknown>;
  reservation(operationId: string): Promise<ReservationRecord | null>;
}
