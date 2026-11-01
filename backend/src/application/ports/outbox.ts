import type { ClaimedOutbox } from '@nipopeto/messaging';

export interface OutboxStore {
  claim(leaseOwner: string, scope: string | null, createdAfter?: string | null): Promise<ClaimedOutbox | null>;
  claimBatch?(
    leaseOwner: string,
    scope: string | null,
    createdAfter: string | null,
    limit: number,
  ): Promise<ClaimedOutbox[]>;
  markPublished(id: string, leaseOwner: string): Promise<void>;
  retry(id: string, leaseOwner: string, nextAttemptAt: Date): Promise<void>;
}
