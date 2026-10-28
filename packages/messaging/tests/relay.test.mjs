import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseOutboxRelay } from '../dist/index.js';

// The claim -> publish -> mark/retry loop both outbox relays share. No broker or database:
// the store is in memory and the publisher is replaced by a fake that confirms or fails by id.
function relayWith({ rows = [], failing = [], batchSize, error = new Error('CONFIRM_TIMEOUT') }) {
  const calls = [];
  const store = {
    async claim(leaseOwner, limit) {
      calls.push(['claim', leaseOwner, limit]);
      return rows.slice(0, limit);
    },
    async markPublished(ids, leaseOwner) {
      calls.push(['markPublished', [...ids], leaseOwner]);
    },
    async retry(id, leaseOwner, at) {
      calls.push(['retry', id, leaseOwner, at]);
    },
  };
  class FakeRelay extends BaseOutboxRelay {
    constructor() {
      super(store, 'amqp://unused.invalid', 'test-relay', { batchSize });
      this.publisher = {
        publish: async (claimed, destination) => {
          calls.push(['publish', claimed.map(r => r.id), destination]);
          const failed = claimed.map(r => r.id).filter(id => failing.includes(id));
          const confirmed = claimed.map(r => r.id).filter(id => !failed.includes(id));
          return failed.length ? { confirmed, failed, error } : { confirmed, failed };
        },
      };
    }
  }
  return { relay: new FakeRelay(), calls };
}
const row = (id, attempts = 1) => ({ id, envelope: { id }, attempts });
const steps = calls => calls.map(c => c[0]);

test('claims up to batchSize rows, publishes them in claim order and marks the confirmed ones published', async () => {
  const { relay, calls } = relayWith({ rows: [row('a'), row('b'), row('c')], batchSize: 2 });
  assert.equal(await relay.once('worker', 'queue'), true);
  assert.deepEqual(steps(calls), ['claim', 'publish', 'markPublished']);
  assert.equal(calls[0][2], 2);
  assert.deepEqual(calls[1], ['publish', ['a', 'b'], 'queue']);
  assert.deepEqual(calls[2][1], ['a', 'b']);
  assert.match(calls[0][1], /^worker:[0-9a-f-]{36}$/);
  assert.equal(calls[2][2], calls[0][1], 'one lease owner for the whole pass');
});

test('an empty claim publishes nothing and returns false', async () => {
  const { relay, calls } = relayWith({ rows: [] });
  assert.equal(await relay.once('worker', 'queue'), false);
  assert.deepEqual(steps(calls), ['claim']);
  assert.equal(calls[0][2], 1, 'the default is one event per pass');
});

test('failed rows are released with a doubling delay capped at 60 s, after the confirmed rows are marked, then the error is thrown', async () => {
  const error = new Error('UNROUTABLE');
  const { relay, calls } = relayWith({
    rows: [row('ok'), row('first', 1), row('late', 3), row('capped', 9)],
    failing: ['first', 'late', 'capped'],
    batchSize: 4,
    error,
  });
  const before = Date.now();
  await assert.rejects(relay.once('worker', 'queue'), caught => caught === error);
  const after = Date.now();
  assert.deepEqual(steps(calls), ['claim', 'publish', 'markPublished', 'retry', 'retry', 'retry']);
  assert.deepEqual(calls[2][1], ['ok']);
  const retries = calls.filter(c => c[0] === 'retry');
  assert.deepEqual(
    retries.map(c => c[1]),
    ['first', 'late', 'capped'],
  );
  [2000, 8000, 60000].forEach((delay, i) => {
    const at = retries[i][3].getTime();
    assert.ok(at >= before + delay && at <= after + delay, `${delay} ms`);
  });
  assert.ok(retries.every(c => c[2] === calls[0][1]));
});

test('with an afterConfirm callback the confirmed rows are marked after it and failed rows are left leased', async () => {
  const { relay, calls } = relayWith({ rows: [row('ok'), row('bad')], failing: ['bad'], batchSize: 2 });
  let confirms = 0;
  await assert.rejects(
    relay.once('worker', 'queue', () => confirms++),
    /CONFIRM_TIMEOUT/,
  );
  assert.equal(confirms, 1);
  assert.deepEqual(steps(calls), ['claim', 'publish', 'markPublished']);
});

test('afterConfirm is not called when nothing was confirmed', async () => {
  const { relay, calls } = relayWith({ rows: [row('bad')], failing: ['bad'] });
  let confirms = 0;
  await assert.rejects(relay.once('worker', 'queue', () => confirms++));
  assert.equal(confirms, 0);
  assert.deepEqual(steps(calls), ['claim', 'publish']);
});

test('batchSize must be a whole number from 1 to 500', () => {
  for (const batchSize of [0, -1, 501, 1.5, Number.NaN, '5'])
    assert.throws(() => relayWith({ batchSize }), /INVALID_RELAY_BATCH/, String(batchSize));
  for (const batchSize of [undefined, 1, 500]) relayWith({ batchSize });
});
