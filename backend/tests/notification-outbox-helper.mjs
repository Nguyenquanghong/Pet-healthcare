import assert from 'node:assert/strict';
import { parseEnvelope } from '@nipopeto/contracts';

// Domain integration suites assert the producer's durable obligation. Delivery,
// inbox dedup and public CRUD are separately exercised by the real broker suites.
export function notificationOutbox(db) {
  const filter = where => ({ AND: [
    { envelope: { path: ['eventType'], equals: 'notification.requested.v1' } },
    ...Object.entries(where).map(([key,value]) => ({envelope:{path:['payload',key],
      ...(typeof value==='object' && value!==null && Object.hasOwn(value,'contains')
        ? {string_contains:value.contains} : {equals:value})}})),
  ] });
  return {
    count: ({where={}}={}) => db.outboxEvent.count({where:filter(where)}),
    async findFirstOrThrow({where}) {
      const row=await db.outboxEvent.findFirstOrThrow({where:filter(where),orderBy:{createdAt:'asc'}});
      const event=parseEnvelope(JSON.stringify(row.envelope));
      assert.equal(event.producer,'core');
      return {id:row.id,...event.payload};
    },
  };
}
