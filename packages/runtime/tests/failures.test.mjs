import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { CircuitBreaker, INTERNAL_ERROR_BODY, isTransientFailure, reportUnexpected } from '../dist/index.js';
import { TransientError, PermanentError } from '@nipopeto/messaging';

const named = (name, props = {}) => Object.assign(new Error('private detail'), { name }, props);

test('dependency failures are transient: Prisma connection and pool codes, retryable conflicts, transport codes', () => {
  assert.equal(isTransientFailure(named('PrismaClientInitializationError', { errorCode: 'P1000' })), true);
  for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'])
    assert.equal(isTransientFailure(named('PrismaClientKnownRequestError', { code })), true, code);
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])
    assert.equal(isTransientFailure(Object.assign(new Error('x'), { code })), true, code);
  assert.equal(isTransientFailure(new TransientError('DIRECTORY_SYNC_UNAVAILABLE')), true);
  assert.equal(isTransientFailure(new DOMException('aborted', 'AbortError')), true);
  assert.equal(isTransientFailure(new DOMException('timed out', 'TimeoutError')), true);
});

test('real transport failures: a refused fetch carries its cause, an expired AbortSignal.timeout is a TimeoutError', async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const refused = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(e => e);
  assert.ok(refused instanceof TypeError, 'undici reports TypeError');
  assert.equal(isTransientFailure(refused), true);
  assert.equal(isTransientFailure(new TypeError('fetch failed')), false, 'without a transport cause it is a bug');
  assert.equal(isTransientFailure(new TypeError('fetch failed', { cause: new Error('boom') })), false);
  const signal = AbortSignal.timeout(5);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.reason.name, 'TimeoutError');
  assert.equal(isTransientFailure(signal.reason), true);
});

test('an open circuit is transient; a business-style or unknown error is not', async () => {
  const breaker = new CircuitBreaker('classifier-target', 1, 60000, () => 0, () => {});
  await assert.rejects(breaker.run(async () => Promise.reject(new Error('down'))), /down/);
  const open = await breaker.run(async () => 1).catch(e => e);
  assert.equal(isTransientFailure(open), true);
  for (const value of [
    new Error('INVALID_DIRECTORY_SYNC'),
    new PermanentError('X_FAILED'),
    named('PrismaClientKnownRequestError', { code: 'P2002' }),
    named('PrismaClientKnownRequestError', { code: 'P2010' }),
    named('PrismaClientValidationError'),
    new RangeError('Invalid array length'),
    Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' }),
    undefined,
    null,
    'ECONNREFUSED',
    503,
  ])
    assert.equal(isTransientFailure(value), false, String(value?.name ?? value));
});

test('the cause chain is followed but bounded, so a cycle cannot hang the handler', () => {
  const inner = Object.assign(new Error('x'), { code: 'ECONNRESET' });
  assert.equal(isTransientFailure(new Error('wrapper', { cause: new Error('mid', { cause: inner }) })), true);
  const loop = new Error('loop');
  loop.cause = loop;
  assert.equal(isTransientFailure(loop), false);
});

test('reportUnexpected writes one fixed-field line without message, stack or URL and returns the 500 body', () => {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = chunk => (lines.push(String(chunk)), true);
  let body;
  try {
    const error = Object.assign(new TypeError('postgres://user:secret@db/clinic refused'), { code: 'ERR_PRIVATE_CODE' });
    body = reportUnexpected('clinic', error, 'req-1');
    reportUnexpected('core', 'plain string');
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(body, { error: 'An unexpected server error occurred.', code: 'INTERNAL_ERROR' });
  assert.equal(body, INTERNAL_ERROR_BODY);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), {
    service: 'clinic',
    code: 'UNEXPECTED_APPLICATION_ERROR',
    requestId: 'req-1',
    errorName: 'TypeError',
    errorCode: 'ERR_PRIVATE_CODE',
  });
  assert.deepEqual(JSON.parse(lines[1]), { service: 'core', code: 'UNEXPECTED_APPLICATION_ERROR' });
  assert.doesNotMatch(lines.join(''), /secret|postgres|stack/);
});
