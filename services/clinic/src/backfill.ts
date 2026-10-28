import { createHash } from 'node:crypto';
import type { PrismaClient } from './generated/client/index.js';
import { ClinicInbox } from './inbox.js';
import { DirectorySync } from './directorySync.js';
import { parseEnvelope, type Envelope } from '@nipopeto/contracts';

// Declare the durable Clinic queue before calling this. Live directory events
// catch up updates during the keyset snapshot; sourceVersion rejects old pages.
export async function backfill(db: PrismaClient, sync: DirectorySync, onPage?: (kind: string) => Promise<void>) {
  const counts: Record<string, number> = {};
  for (const kind of ['owner', 'pet', 'staff']) {
    let cursor: string | undefined;
    counts[kind] = 0;
    do {
      const page = await sync.page(kind, cursor);
      for (const row of page.items) {
        const id =
          'directory-backfill:' + createHash('sha256').update(`${kind}:${row.id}:${row.sourceVersion}`).digest('hex');
        const envelope: Envelope = {
          eventId: id,
          eventType: `directory.${kind}-upserted.v1` as Envelope['eventType'],
          schemaVersion: 1,
          producer: 'core',
          aggregateType: kind,
          aggregateId: row.id,
          aggregateVersion: row.sourceVersion,
          occurredAt: new Date().toISOString(),
          correlationId: id,
          payload: {
            id: row.id,
            sourceVersion: row.sourceVersion,
            displayName: row.displayName.slice(0, 200),
            ...(kind === 'pet' ? { ownerId: row.ownerId } : {}),
            deletedAt: null,
          },
        };
        const raw = JSON.stringify(envelope);
        parseEnvelope(raw);
        await new ClinicInbox(db, async () => row).apply(raw);
        counts[kind]!++;
      }
      await onPage?.(kind);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return counts;
}
