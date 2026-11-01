import type { BillingSourceSnapshot, Envelope } from '@nipopeto/contracts';
import type { Actor } from '../../domain/auth.js';
import type { Fees, InvoiceLine } from '../../domain/billing/charges.js';
import type { InvoiceNotice, InvoiceValue } from './invoices.js';

// A row of AppointmentBillingOperation. `state` is a free String in the database, not an enum.
export type BillingOperationRecord = {
  id: string;
  actorId: string;
  actorRole: string;
  operationType: string;
  idempotencyKey: string;
  requestHash: string;
  appointmentId: string;
  expectedRevision: number | null;
  payload: unknown;
  state: string;
  invoiceId: string | null;
  snapshot: unknown;
  errorCode: string | null;
  errorStatus: number | null;
  createdAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
  finalizedAt: Date | null;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
};

export type BillingRemote = {
  source: (id: string, actor: Actor) => Promise<BillingSourceSnapshot>;
  prepare: (operation: BillingOperationRecord, actor: Actor) => Promise<BillingSourceSnapshot>;
  finalize: (operation: BillingOperationRecord) => Promise<void>;
};

export type BillingOperationRow = {
  id: string;
  actorId: string;
  actorRole: string;
  operationType: string;
  idempotencyKey: string;
  requestHash: string;
  appointmentId: string;
  payload: Fees;
  expectedRevision: number | null;
};

export type OperationInvoice = { id: string; ownerId: string; sourceSnapshot: unknown };
export type BillingInvoice = InvoiceValue & { sourceSnapshot?: unknown };

export type AppointmentInvoiceData = {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  notes: string | null;
  id: string;
  invoiceCode: string;
  type: 'appointment';
  ownerId: string;
  petId: string;
  appointmentId: string;
  sourceSnapshot: BillingSourceSnapshot;
  items: InvoiceLine[];
};

export type TerminalUpdate = {
  state: 'COMMITTED' | 'ABORTED';
  invoiceId: string | null;
  snapshot: BillingSourceSnapshot | undefined;
  terminalAt: Date;
  finalizedAt?: Date;
  errorStatus: number | undefined;
  errorCode: string | undefined;
};

// What the one transaction of a terminal step may do. The store opens it, locks the row and reads the operation first;
// everything below runs in that transaction, so a throw rolls all of it back.
export interface BillingTerminalTx {
  invoiceForAppointment(appointmentId: string): Promise<OperationInvoice | null>;
  createInvoice(data: AppointmentInvoiceData): Promise<{ id: string; invoiceCode: string }>;
  notify(draft: InvoiceNotice): Promise<void>;
  update(id: string, data: TerminalUpdate): Promise<BillingOperationRecord>;
  publish(event: Envelope): Promise<void>;
}

export interface BillingOperationStore {
  actorRole(id: string): Promise<string | null>;
  // Inserts the operation unless the key or the pending appointment already has one, then reads the row of the key.
  insertAndRead(row: BillingOperationRow): Promise<BillingOperationRecord | null>;
  find(id: string): Promise<BillingOperationRecord | null>;
  invoiceForAppointment(appointmentId: string): Promise<OperationInvoice | null>;
  invoiceWithItems(id: string): Promise<BillingInvoice>;
  // Sets the revision only while the operation is PREPARING and has none.
  setExpectedRevision(id: string, revision: number): Promise<void>;
  ownerFacts(
    snapshot: BillingSourceSnapshot,
  ): Promise<{ pet: { ownerId: string } | null; owner: { role: string } | null }>;
  // Locks the operation row (FOR UPDATE), runs afterLock, reads the operation, then runs `work` in the same transaction.
  terminal<T>(
    id: string,
    work: (tx: BillingTerminalTx, op: BillingOperationRecord) => Promise<T>,
    afterLock?: () => Promise<void>,
  ): Promise<T>;
  claimDue(workerId: string, limit: number, operationId?: string): Promise<{ id: string }[]>;
  markFinalized(id: string, workerId: string): Promise<void>;
  release(id: string, workerId: string, nextAttemptAt: Date): Promise<void>;
  isUniqueViolation(error: unknown): boolean;
}
