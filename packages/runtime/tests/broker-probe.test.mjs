import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceRuntime } from '../dist/index.js';

// The readiness probe keeps one AMQP connection instead of opening and closing one every few seconds.
const snapshot = { pending: 0, outboxAgeSeconds: 0, outboxRetries: 0, billingPending: 0, billingAgeSeconds: 0, dbLockWaits: 0 };
function runtime(t, env = {}) {
  Object.assign(process.env, {
    OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
    RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
    REDIS_URL: 'redis://127.0.0.1:1',
    RATE_LIMIT_NAMESPACE: 'broker-probe-test',
    BROKER_URL: 'amqp://probe:probe@127.0.0.1:1',
  }, env);
  t.after(() => { for (const key of ['BROKER_URL', ...Object.keys(env)]) delete process.env[key]; });
  const rt = new ServiceRuntime({ service: 'clinic', verify: () => ({ sub: 'owner', role: 'owner' }), probe: async () => snapshot });
  t.after(() => rt.close());
  return rt;
}
const fakeConnection = () => ({ closed: 0, async close() { this.closed++; } });

test('a probe that outlives its deadline reports the broker down and drops the kept connection', async t => {
  const rt = runtime(t, { BROKER_PROBE_TIMEOUT_MS: '200' });
  const kept = fakeConnection();
  rt.probing = kept;
  rt.probeBroker = () => new Promise(() => {});
  const started = performance.now();
  assert.equal(await rt.brokerProbe(), false);
  assert.ok(performance.now() - started >= 190 && performance.now() - started < 1500, 'bounded by the deadline');
  assert.equal(kept.closed, 1);
  assert.equal(rt.probing, undefined);
});

test('a probe that answers in time keeps its connection', async t => {
  const rt = runtime(t);
  const kept = fakeConnection();
  rt.probing = kept;
  rt.probeBroker = async () => true;
  assert.equal(await rt.brokerProbe(), true);
  assert.equal(rt.probing, kept);
  assert.equal(kept.closed, 0);
});

test('an unreachable broker is down, leaves nothing behind, and no BROKER_URL means not available', async t => {
  const rt = runtime(t);
  assert.equal(await rt.brokerProbe(), false);
  assert.equal(rt.probing, undefined);
  delete process.env.BROKER_URL;
  assert.equal(await rt.brokerProbe(), false);
});

test('a lost connection is forgotten so the next probe opens a new one; closing the runtime closes the kept one', async t => {
  const rt = runtime(t);
  const broken = { closed: 0, async close() { this.closed++; throw new Error('already closed'); } };
  rt.probing = broken;
  rt.probeConnection = async () => { throw new Error('connect failed'); };
  assert.equal(await rt.probeBroker('amqp://x'), false);
  assert.equal(rt.probing, undefined, 'dropped after a failure');
  assert.equal(broken.closed, 1);
  const kept = fakeConnection();
  rt.probing = kept;
  rt.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kept.closed, 1);
  assert.equal(rt.probing, undefined);
});
