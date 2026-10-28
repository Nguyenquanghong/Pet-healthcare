import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('/metrics exports each breaker: pet_circuit_open is 1 only while the breaker is refusing calls', async t => {
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
  now += 999;
  assert.equal(breaker.rejecting, true);
  assert.match(rt.metrics(), /pet_circuit_open\{service="core",target="metric-clinic-gateway"\} 1\n/, 'still refusing until the wait is over');
  now += 1;
  assert.equal(breaker.state, 'half-open');
  assert.equal(breaker.rejecting, false);
  assert.match(rt.metrics(), /pet_circuit_open\{service="core",target="metric-clinic-gateway"\} 0\n/, 'half-open lets the next call through, so nothing is being refused');
  assert.equal(await breaker.run(async () => 'ok'), 'ok');
  assert.match(rt.metrics(), /pet_circuit_open\{service="core",target="metric-clinic-gateway"\} 0\n/);
});

test('a quiet system whose breaker opened once reads 0 after the wait; a failing trial call refuses again and reads 1', async t => {
  const rt = runtime('core');
  t.after(() => rt.close());
  let now = 0;
  const breaker = new CircuitBreaker('metric-idle-clinic', 1, 1000, () => now, () => {});
  const open = () => sample(rt.metrics(), 'pet_circuit_open', 'metric-idle-clinic').slice(-1);
  await assert.rejects(breaker.run(fail), /down/);
  assert.equal(open(), '1');
  now += 60_000;
  assert.equal(open(), '0', 'no request has come in since, yet nothing is refusing');
  await assert.rejects(breaker.run(fail), /down/, 'the trial call fails');
  assert.equal(open(), '1');
  assert.match(sample(rt.metrics(), 'pet_circuit_opened_total', 'metric-idle-clinic'), / 2$/, 'every opening counts, a failed trial call included');
  await assert.rejects(breaker.run(async () => 1), /CIRCUIT_OPEN/);
  assert.match(sample(rt.metrics(), 'pet_circuit_rejected_total', 'metric-idle-clinic'), / 1$/);
});

test('the CircuitOpen alert watches refused calls, not the gauge that is 0 between trial calls', () => {
  const rule = JSON.parse(readFileSync(new URL('../../../deploy/phase2/alerts.json', import.meta.url), 'utf8')).rules.find(r => r.name === 'CircuitOpen');
  assert.equal(rule.metric, 'pet_circuit_rejected_total');
  assert.match(rule.condition, /^increase\(pet_circuit_rejected_total\[\d+m\]\) > 0$/);
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
