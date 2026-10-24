import test from 'node:test';
import assert from 'node:assert/strict';
import { PermanentError, TransientError, defaultClassify, defaultRetryDelaysMs, failureCode, permanentOn, retryDelays, retryQueue, retryTarget } from '../dist/index.js';

// P03: where a failed message goes, as a pure function of attempt, kind and ladder.
test('a transient failure walks the ladder one delay queue per attempt, then reaches the DLQ', () => {
  const delays = [1000, 5000, 30000];
  assert.deepEqual([0, 1, 2, 3].map(attempt => retryTarget('q', attempt, 'transient', delays)), [
    { queue: 'q.retry.1000ms', delay: 1000 }, { queue: 'q.retry.5000ms', delay: 5000 }, { queue: 'q.retry.30000ms', delay: 30000 }, { queue: 'q.dlq', delay: null },
  ]);
  assert.deepEqual(retryTarget('q', 0, 'permanent', delays), { queue: 'q.dlq', delay: null }, 'a permanent failure is never retried');
  assert.deepEqual(retryTarget('q', 0, 'transient', []), { queue: 'q.dlq', delay: null });
  assert.equal(retryQueue('nipopeto.v1.clinic', 120000), 'nipopeto.v1.clinic.retry.120000ms');
});

test('the default ladder is 1 s, 5 s, 30 s, 2 min, 10 min; BROKER_RETRY_DELAYS_MS replaces it when valid', () => {
  assert.deepEqual(retryDelays(undefined), [1000, 5000, 30000, 120000, 600000]);
  assert.equal(defaultRetryDelaysMs.reduce((a, b) => a + b, 0), 756000, 'about 12.6 minutes before the DLQ');
  assert.deepEqual(retryDelays(''), [...defaultRetryDelaysMs]);
  assert.deepEqual(retryDelays('20,40'), [20, 40]);
  for (const raw of ['0', '-5', '1.5', '100,100', '200,100', 'abc', '1,2,3,4,5,6,7', '3600001', '1,,2'])
    assert.throws(() => retryDelays(raw), /INVALID_BROKER_RETRY_DELAYS/, raw);
});

test('unknown failures are transient; services name what is permanent', () => {
  assert.equal(defaultClassify(new Error('fetch failed')), 'transient');
  assert.equal(defaultClassify(new TransientError('DIRECTORY_SYNC_UNAVAILABLE')), 'transient');
  assert.equal(defaultClassify(new PermanentError('BAD_PAYLOAD')), 'permanent');
  assert.equal(defaultClassify('not an error'), 'transient');
  const clinic = permanentOn(['TERMINAL_CONFLICT'], error => error?.name === 'PrismaClientValidationError');
  assert.equal(clinic(new Error('TERMINAL_CONFLICT')), 'permanent');
  assert.equal(clinic(Object.assign(new Error('Invalid invocation'), { name: 'PrismaClientValidationError' })), 'permanent');
  assert.equal(clinic(Object.assign(new Error("Can't reach database server"), { code: 'P1001' })), 'transient');
  assert.equal(clinic(new Error('TERMINAL_CONFLICT_SOON')), 'transient', 'codes match exactly, not by prefix');
});

test('the error code header carries a code, never free text', () => {
  assert.equal(failureCode(new TransientError('DIRECTORY_SYNC_UNAVAILABLE')), 'DIRECTORY_SYNC_UNAVAILABLE');
  assert.equal(failureCode(new Error('TERMINAL_CONFLICT')), 'TERMINAL_CONFLICT');
  assert.equal(failureCode(Object.assign(new Error('Unique constraint failed on owner@example.test'), { code: 'P2002' })), 'P2002');
  assert.equal(failureCode(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  for (const error of [new Error('fetch failed'), new Error('Owner 0912345678 not found'), new Error('X'), null, 'TEXT'])
    assert.equal(failureCode(error), 'PROCESSING_FAILED');
});
