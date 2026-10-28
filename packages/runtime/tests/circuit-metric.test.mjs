import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, ServiceRuntime, circuitBreakers } from '../dist/index.js';

const snapshot = { pending: 0, outboxAgeSeconds: 0, outboxRetries: 0, billingPending: 0, billingAgeSeconds: 0, dbLockWaits: 0 };
const fail = async () => { throw new Error('down'); };

function runtime(service) {
  Object.assign(process.env, {
    OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
    RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
    REDIS_URL: 'redis://127.0.0.1:1',
    RATE_LIMIT_NAMESPACE: 'circuit-metric-test',
  });
  return new ServiceRuntime({ service, verify: () => ({ sub: 'owner', role: 'owner' }), probe: async () => snapshot });
}
const sample = (text, name, target) =>
  text.split('\n').find(line => line.startsWith(`${name}{`) && line.includes(`target="${target}"`));

test('/metrics exports each breaker: pet_circuit_open is 1 while open or half-open and 0 once closed', async t => {
  const rt = runtime('core');
  t.after(() => rt.close());
  let now = 0;
  const breaker = new CircuitBreaker('metric-clinic-gateway', 2, 1000, () => now, () => {});
  assert.ok(circuitBreakers().includes(breaker));
  assert.equal(sample(rt.metrics(), 'pet_circuit_open', 'metric-clinic-gateway'), 'pet_circuit_open{service="core",target="metric-clinic-gateway"} 0');
  for (let i = 0; i < 2; i++) await assert.rejects(breaker.run(fail), /down/);
  await assert.rejects(breaker.run(async () => 1), /CIRCUIT_OPEN/);
  const open = rt.metrics();
  assert.equal(sample(open, 'pet_circuit_open', 'metric-clinic-gateway'), 'pet_circuit_open{service="core",target="metric-clinic-gateway"} 1');
  assert.equal(sample(open, 'pet_circuit_opened_total', 'metric-clinic-gateway'), 'pet_circuit_opened_total{service="core",target="metric-clinic-gateway"} 1');
  assert.equal(sample(open, 'pet_circuit_rejected_total', 'metric-clinic-gateway'), 'pet_circuit_rejected_total{service="core",target="metric-clinic-gateway"} 1');
  now += 1000;
  assert.equal(breaker.state, 'half-open');
  assert.match(rt.metrics(), /pet_circuit_open\{service="core",target="metric-clinic-gateway"\} 1\n/, 'half-open is not closed yet');
  assert.equal(await breaker.run(async () => 'ok'), 'ok');
  assert.match(rt.metrics(), /pet_circuit_open\{service="core",target="metric-clinic-gateway"\} 0\n/);
});

test('two breakers with one target make one series; the service label follows the runtime', async t => {
  const rt = runtime('clinic');
  t.after(() => rt.close());
  const a = new CircuitBreaker('metric-core-directory', 1, 1000, () => 0, () => {});
  const b = new CircuitBreaker('metric-core-directory', 1, 1000, () => 0, () => {});
  await assert.rejects(a.run(fail), /down/);
  const lines = rt.metrics().split('\n').filter(line => line.startsWith('pet_circuit_open{') && line.includes('metric-core-directory'));
  assert.deepEqual(lines, ['pet_circuit_open{service="clinic",target="metric-core-directory"} 1']);
  assert.equal(b.state, 'closed');
});
