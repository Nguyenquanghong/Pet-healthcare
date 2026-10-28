import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ServiceRuntime } from '../dist/index.js';

// The readiness probe keeps one AMQP connection instead of opening and closing one every few seconds.
// The broker is a fake injected through the runtime's `connect` option.
const snapshot = { pending: 0, outboxAgeSeconds: 0, outboxRetries: 0, billingPending: 0, billingAgeSeconds: 0, dbLockWaits: 0 };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
  return d;
};
const queueReady = rt => /pet_queue_ready\{[^}]*\} (-?\d+)/.exec(rt.metrics())?.[1];

// Counts what the probe did to it: channels opened and closed, times the connection itself was closed.
function fakeConnection(messages = 0) {
  const connection = Object.assign(new EventEmitter(), {
    channelsOpened: 0,
    channelsClosed: 0,
    closed: 0,
    channel(count = messages) {
      return Object.assign(new EventEmitter(), {
        checkQueue: async () => ({ messageCount: count }),
        close: async () => void connection.channelsClosed++,
      });
    },
    async createChannel() {
      connection.channelsOpened++;
      return connection.channel();
    },
    async close() {
      connection.closed++;
      connection.emit('close');
    },
  });
  return connection;
}
// Each connect takes the next step: a connection, a promise of one, or a function that returns either.
function fakeBroker(...steps) {
  const broker = {
    connects: 0,
    connect: async () => {
      broker.connects++;
      const step = steps.shift();
      return typeof step === 'function' ? step() : step;
    },
  };
  return broker;
}
function runtime(t, broker, { service = 'clinic', ...env } = {}) {
  Object.assign(
    process.env,
    {
      OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
      RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
      REDIS_URL: 'redis://127.0.0.1:1',
      RATE_LIMIT_NAMESPACE: 'broker-probe-test',
      BROKER_URL: 'amqp://probe:probe@127.0.0.1:1',
      BROKER_PROBE_TIMEOUT_MS: '200',
    },
    env,
  );
  t.after(() => {
    for (const key of ['BROKER_URL', 'BROKER_PROBE_TIMEOUT_MS', ...Object.keys(env)]) delete process.env[key];
  });
  const rt = new ServiceRuntime({
    service,
    verify: () => ({ sub: 'owner', role: 'owner' }),
    probe: async () => snapshot,
    connect: broker.connect,
  });
  t.after(() => rt.close());
  return rt;
}

test('a probe that outlives its deadline reports the broker down and closes the kept connection', async t => {
  const stuck = fakeConnection();
  stuck.createChannel = () => new Promise(() => {});
  const fresh = fakeConnection();
  const broker = fakeBroker(stuck, fresh);
  const rt = runtime(t, broker);
  const started = performance.now();
  assert.equal(await rt.brokerProbe(), false);
  assert.ok(performance.now() - started >= 190 && performance.now() - started < 1500, 'bounded by the deadline');
  assert.equal(stuck.closed, 1);
  assert.equal(await rt.brokerProbe(), true, 'the next probe opens a new connection');
  assert.equal(broker.connects, 2);
  assert.equal(fresh.closed, 0);
});

test('a probe that answers in time keeps its connection and makes a real round trip every time', async t => {
  const kept = fakeConnection();
  const broker = fakeBroker(kept);
  const rt = runtime(t, broker);
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(broker.connects, 1);
  assert.equal(kept.closed, 0);
  assert.deepEqual([kept.channelsOpened, kept.channelsClosed], [2, 2], 'a channel is opened and closed per probe');
});

test('a held connection that stops answering is down, also for core and without a queue prefix', async t => {
  for (const [service, env] of [
    ['core', { BROKER_PREFIX: 'p' }],
    ['core', {}],
    ['clinic', {}],
  ]) {
    await t.test(`${service}${env.BROKER_PREFIX ? ' with prefix' : ' without prefix'}`, async t => {
      const partitioned = fakeConnection();
      const replacement = fakeConnection();
      const broker = fakeBroker(partitioned, replacement);
      const rt = runtime(t, broker, { service, ...env });
      assert.equal(await rt.brokerProbe(), true);
      assert.deepEqual([partitioned.channelsOpened, partitioned.channelsClosed], [1, 1]);
      partitioned.createChannel = () => new Promise(() => {});
      assert.equal(await rt.brokerProbe(), false, 'holding the connection is not an answer');
      assert.equal(partitioned.closed, 1);
      assert.equal(await rt.brokerProbe(), true);
      assert.equal(broker.connects, 2);
    });
  }
});

test('an unreachable broker is down and leaves nothing behind; no BROKER_URL means not available', async t => {
  const broker = fakeBroker(() => Promise.reject(new Error('connect failed')));
  const rt = runtime(t, broker);
  assert.equal(await rt.brokerProbe(), false);
  assert.equal(broker.connects, 1);
  delete process.env.BROKER_URL;
  assert.equal(await rt.brokerProbe(), false);
  assert.equal(broker.connects, 1, 'no URL, no connect');
});

test('a lost connection is forgotten so the next probe opens a new one; closing the runtime closes the kept one', async t => {
  const broken = fakeConnection();
  broken.createChannel = async () => {
    throw new Error('channel closed');
  };
  broken.close = async () => {
    broken.closed++;
    throw new Error('already closed');
  };
  const kept = fakeConnection();
  const broker = fakeBroker(broken, kept);
  const rt = runtime(t, broker);
  assert.equal(await rt.brokerProbe(), false);
  assert.equal(broken.closed, 1, 'dropped after a failure');
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(broker.connects, 2);
  rt.close();
  await settle();
  assert.equal(kept.closed, 1);
  assert.equal(await rt.brokerProbe(), false, 'a closed runtime does not reconnect');
  assert.equal(broker.connects, 2);
});

test('a stale probe failing late does not close the connection a newer probe opened', async t => {
  const rpc = deferred();
  const old = fakeConnection();
  old.createChannel = () => rpc.promise;
  const newer = fakeConnection(7);
  const broker = fakeBroker(old, newer);
  const rt = runtime(t, broker, { BROKER_PREFIX: 'p' });
  assert.equal(await rt.brokerProbe(), false);
  assert.equal(old.closed, 1);
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(queueReady(rt), '7');
  rpc.reject(new Error('channel closed'));
  await settle();
  await settle();
  assert.equal(newer.closed, 0, 'the old probe closed a connection that was not its own');
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(broker.connects, 2, 'the newer connection is still the kept one');
});

test('a stale probe that answers late does not overwrite the newer probe\'s queue counts', async t => {
  const rpc = deferred();
  const old = fakeConnection(99);
  old.createChannel = () => rpc.promise;
  const newer = fakeConnection(7);
  const rt = runtime(t, fakeBroker(old, newer), { BROKER_PREFIX: 'p' });
  assert.equal(await rt.brokerProbe(), false);
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(queueReady(rt), '7');
  rpc.resolve(old.channel());
  await settle();
  await settle();
  assert.equal(queueReady(rt), '7');
  assert.equal(newer.closed, 0);
});

test('close() while the connect is still in flight closes the connection that arrives instead of keeping it', async t => {
  const connecting = deferred();
  const late = fakeConnection();
  const broker = fakeBroker(() => connecting.promise);
  const rt = runtime(t, broker);
  const probe = rt.brokerProbe();
  await settle();
  rt.close();
  connecting.resolve(late);
  assert.equal(await probe, false);
  await settle();
  assert.equal(late.closed, 1);
  assert.equal(late.channelsOpened, 0, 'it was never used');
  assert.equal(late.listenerCount('close'), 0, 'and never kept');
});

test('probes that overlap share one connect and keep one connection', async t => {
  const connecting = deferred();
  const only = fakeConnection();
  const broker = fakeBroker(() => connecting.promise, fakeConnection());
  const rt = runtime(t, broker);
  assert.equal(await rt.brokerProbe(), false, 'the first probe gives up while connecting');
  const second = rt.brokerProbe();
  await settle();
  assert.equal(broker.connects, 1, 'the second probe waits for the connect already running');
  connecting.resolve(only);
  assert.equal(await second, true);
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(broker.connects, 1);
  assert.equal(only.closed, 0);
});
