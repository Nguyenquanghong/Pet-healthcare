import type { EventType } from '@nipopeto/contracts';

// F7: each billing event Clinic consumes names its terminal outcome. A billing
// type without an entry is refused (and dead-lettered), never read as an abort.
export const billingOutcomes = {
  'billing.invoice-issued.v1': { terminal: 'COMMITTED', reservation: 'INVOICED' },
  'billing.operation-aborted.v1': { terminal: 'ABORTED', reservation: 'RELEASED' },
} as const satisfies Partial<Record<EventType, { terminal: 'COMMITTED' | 'ABORTED'; reservation: 'INVOICED' | 'RELEASED' }>>;
export type BillingOutcome = typeof billingOutcomes[keyof typeof billingOutcomes];

export function billingOutcome(eventType: string): BillingOutcome | undefined {
  return Object.hasOwn(billingOutcomes, eventType) ? billingOutcomes[eventType as keyof typeof billingOutcomes] : undefined;
}
