import { randomUUID } from 'node:crypto';
import { ConfirmPublisher, type OutboxMessage } from './publisher.js';
import { type Topology } from './topology.js';
// batchSize/persistent default to the original one-event, one-connection relay; the workers
// enable both (a fresh AMQP connection per event capped a relay near 11 events/s, list study K3-F1).
export type RelayOptions = { batchSize?: number; persistent?: boolean };
export type ClaimedOutbox = OutboxMessage & { attempts: number };
// The rows of one service's outbox. claim leases up to `limit` due rows in creation order;
// markPublished and retry only touch rows still leased to leaseOwner.
export interface OutboxRelayStore {
  claim(leaseOwner: string, limit: number): Promise<ClaimedOutbox[]>;
  markPublished(ids: string[], leaseOwner: string): Promise<void>;
  retry(id: string, leaseOwner: string, nextAttemptAt: Date): Promise<void>;
}
// claim -> publish -> mark the confirmed rows published -> release the failed ones with
// backoff (1 s doubling to 60 s). Each service supplies where its rows live.
export class BaseOutboxRelay {
  protected readonly publisher: ConfirmPublisher;
  protected readonly batchSize: number;
  constructor(
    private readonly store: OutboxRelayStore,
    brokerUrl: string,
    service: string,
    options: RelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 1;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500)
      throw new Error('INVALID_RELAY_BATCH');
    this.publisher = new ConfirmPublisher(brokerUrl, service, options.persistent ?? false);
  }
  get connection() {
    return this.publisher.connection;
  }
  close() {
    return this.publisher.close();
  }
  async once(workerId: string, destination: string | Topology, afterConfirm?: () => void) {
    const started = performance.now();
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const claimed = await this.store.claim(leaseOwner, this.batchSize);
    if (!claimed.length) return false;
    const { confirmed, failed, error } = await this.publisher.publish(claimed, destination, started);
    if (confirmed.length) {
      afterConfirm?.();
      await this.store.markPublished(confirmed, leaseOwner);
    }
    if (failed.length) {
      if (!afterConfirm)
        for (const row of claimed.filter(r => failed.includes(r.id)))
          await this.store.retry(
            row.id,
            leaseOwner,
            new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))),
          );
      throw error;
    }
    return true;
  }
}
