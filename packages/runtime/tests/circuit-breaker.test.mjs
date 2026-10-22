import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError } from '../dist/index.js';

const clock = () => { let t = 0; return { now: () => t, advance: ms => { t += ms; } }; };
const quiet = entries => entry => entries.push(entry.code);
const fail = async () => { throw new Error('down'); };
const ok = async () => 'ok';

test('opens after consecutive dependency failures and then fails fast without calling', async () => {
  const c = clock(), log = [], breaker = new CircuitBreaker('core-directory', 3, 1000, c.now, quiet(log));
  for (let i = 0; i < 3; i++) await assert.rejects(breaker.run(fail), /down/);
  assert.equal(breaker.state, 'open');
  let called = false;
  await assert.rejects(breaker.run(async () => { called = true; }), CircuitOpenError);
  assert.equal(called, false);
  assert.deepEqual(breaker.counters, { opened: 1, rejected: 1 });
  assert.deepEqual(log, ['CIRCUIT_OPEN']);
});

test('a success resets the count; business refusals are successes, not failures', async () => {
  const breaker = new CircuitBreaker('core-directory', 2, 1000, clock().now, () => {});
  await assert.rejects(breaker.run(fail), /down/);
  assert.equal(await breaker.run(ok), 'ok');
  await assert.rejects(breaker.run(fail), /down/);
  assert.equal(breaker.state, 'closed');
  const refused = Object.assign(new Error('forbidden'), { business: true });
  for (let i = 0; i < 5; i++) await assert.rejects(breaker.run(async () => { throw refused; }, e => !e.business), /forbidden/);
  assert.equal(breaker.state, 'closed');
});

test('after the open window one probe goes through: success closes, failure reopens', async () => {
  const c = clock(), log = [], breaker = new CircuitBreaker('core-directory', 1, 1000, c.now, quiet(log));
  await assert.rejects(breaker.run(fail));
  c.advance(999);
  await assert.rejects(breaker.run(ok), CircuitOpenError);
  c.advance(1);
  assert.equal(breaker.state, 'half-open');
  await assert.rejects(breaker.run(fail), /down/);
  assert.equal(breaker.state, 'open');
  c.advance(1000);
  assert.equal(await breaker.run(ok), 'ok');
  assert.equal(breaker.state, 'closed');
  assert.deepEqual(log, ['CIRCUIT_OPEN', 'CIRCUIT_HALF_OPEN', 'CIRCUIT_OPEN', 'CIRCUIT_HALF_OPEN', 'CIRCUIT_CLOSED']);
});

test('only one probe at a time while half-open', async () => {
  const c = clock(), breaker = new CircuitBreaker('core-directory', 1, 1000, c.now, () => {});
  await assert.rejects(breaker.run(fail));
  c.advance(1000);
  let release;
  const probe = breaker.run(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(breaker.run(ok), CircuitOpenError);
  release('done');
  assert.equal(await probe, 'done');
  assert.equal(await breaker.run(ok), 'ok');
});

test('configuration is validated', () => {
  for (const args of [['Bad Name', 1, 1], ['core', 0, 1], ['core', 1, 0], ['core', 1.5, 1]])
    assert.throws(() => new CircuitBreaker(...args), /INVALID_CIRCUIT_BREAKER/);
});
