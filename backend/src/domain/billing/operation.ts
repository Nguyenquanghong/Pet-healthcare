export type BillingOperationState = 'PREPARING' | 'COMMITTED' | 'ABORTED';

// An operation leaves PREPARING once and never moves again. The table documents the rule; nothing reads it at run time.
export const billingOperationTransitions: Record<BillingOperationState, readonly BillingOperationState[]> = {
  PREPARING: ['COMMITTED', 'ABORTED'],
  COMMITTED: [],
  ABORTED: [],
};

// `state` is a free String in the database, so a value this code does not know is not pending either. The test is a
// string comparison on purpose, not a lookup in the table above.
export const isPending = (state: string): boolean => state === 'PREPARING';

export const terminalState = (action: 'commit' | 'abort'): 'COMMITTED' | 'ABORTED' =>
  action === 'commit' ? 'COMMITTED' : 'ABORTED';
