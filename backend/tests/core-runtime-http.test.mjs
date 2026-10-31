import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { ServiceRuntime } from '@nipopeto/runtime';
import { coreRuntime } from '../dist/src/composition/runtime.js';
import { coreBodyLimits, coreLimitRules, coreRouteLabel } from '../dist/src/composition/limitRules.js';
import { signToken } from '../dist/src/lib/token.js';

// The shared runtime knows no Core route. Core hands it the sign-in and rescue limits, the 16kb sign-in body limit and the
// metric labels; if coreRuntime stopped passing them, these tests fail instead of the limiter going quiet.
const snapshot = {
  pending: 0,
  outboxAgeSeconds: 0,
  outboxRetries: 0,
  billingPending: 0,
  billingAgeSeconds: 0,
  dbLockWaits: 0,
};
async function core(t) {
  for (const key of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_KEY_ID'])
    delete process.env[key];
  Object.assign(process.env, {
    JWT_SECRET: randomBytes(32).toString('hex'),
    PHASE2_RUNTIME_REQUIRED: '1',
    OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
    RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
    REDIS_URL: 'redis://127.0.0.1:1',
    RATE_LIMIT_NAMESPACE: 'core-runtime-http-test',
  });
  const rt = coreRuntime({ $transaction: async () => snapshot });
  const spent = [];
  rt.limiter.spend = async (group, buckets) => {
    spent.push({ group, buckets });
    return rt.limiter.localRead(group, buckets);
  };
  rt.limiter.ping = async () => true;
  rt.brokerProbe = async () => true;
  await rt.start();
  const app = express();
  rt.install(app);
  app.all('/api/*splat', (_req, res) => res.status(201).json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'refused' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    rt.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const send = (path, init = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
      ...init,
    });
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { rt, send, json, spent };
}

test('coreRuntime passes the rules, the body limits and the label table to the shared runtime', async t => {
  const { rt } = await core(t);
  assert.ok(rt instanceof ServiceRuntime);
  assert.equal(rt.options.limitRules, coreLimitRules);
  assert.ok(coreLimitRules.length >= 5, 'sign-in, register, activation, rescue and password rules are Core rules');
  assert.deepEqual(rt.options.bodyLimits, [{ path: '/api/auth', limit: '16kb' }]);
  assert.deepEqual(coreBodyLimits, [{ path: '/api/auth', limit: '16kb' }]);
  assert.equal(rt.options.routeLabel, coreRouteLabel);
});

test('sign-in, register, activation and password requests spend their own buckets; the body is read first', async t => {
  const { send, json, spent } = await core(t);
  const group = () => spent.at(-1).group;
  assert.equal((await send('/api/auth/owner/login', json({ email: '  Ann@Example.com ' }))).status, 201);
  assert.equal(group(), 'auth-login');
  assert.deepEqual(
    spent.at(-1).buckets.map(b => [b.limit, b.windowMs]),
    [
      [1000, 900000],
      [30, 900000],
    ],
  );
  assert.equal(spent.at(-1).buckets[1].identity, 'account:/auth/owner/login:ann@example.com');
  assert.equal((await send('/api/auth/admin/login', json({ username: 'Root' }))).status, 201);
  assert.equal(spent.at(-1).buckets[1].identity, 'account:/auth/admin/login:root');
  assert.equal((await send('/api/auth/admin/login', json({ email: 5 }))).status, 201);
  assert.equal(spent.at(-1).buckets[1].identity, 'account:/auth/admin/login:invalid');
  await send('/api/auth/owner/register', json({}));
  assert.equal(group(), 'auth-register');
  assert.equal(spent.at(-1).buckets[0].limit, 300);
  await send('/api/auth/owner/activation/inspect', json({}));
  assert.equal(group(), 'auth-activation');
  const token = signToken('owner-1', 'owner');
  await send('/api/auth/me/password', {
    ...json({}),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  });
  assert.equal(group(), 'auth-password');
  assert.equal(spent.at(-1).buckets[0].identity, 'actor:owner-1');
  assert.ok(spent.at(-1).buckets[1].identity.startsWith('ip:'));
  assert.deepEqual(
    spent.at(-1).buckets.map(b => b.limit),
    [10, 200],
  );
  await send('/api/pets', json({}));
  assert.equal(group(), 'core-write', 'other writes keep the general policy');
});

test('sign-in bodies over 16kb are refused before the limiter; other paths keep their own parser', async t => {
  const { send, json, spent } = await core(t);
  const before = spent.length;
  assert.equal((await send('/api/auth/owner/login', json({ email: 'x'.repeat(17000) }))).status, 413);
  assert.equal(spent.length, before, 'refused before any bucket is spent');
});

test('reads under /auth and /public use the shared limiter; other reads are counted per instance', async t => {
  const { send, spent } = await core(t);
  assert.equal((await send('/api/auth/me', { method: 'GET' })).status, 201);
  assert.deepEqual(
    spent.map(s => s.group),
    ['core-read'],
  );
  assert.equal((await send('/api/public/rescue/tok', { method: 'GET' })).status, 201);
  assert.equal(spent.length, 2);
  assert.equal((await send('/api/pets', { method: 'GET' })).status, 201);
  assert.equal(spent.length, 2, '/api/pets is per instance: no Redis round trip');
});

test('the rescue form keeps its three buckets and the token is decoded before it is counted', async t => {
  const { send, spent } = await core(t);
  await send('/api/public/pets/%74ok-a/rescue-reports', {
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(spent.at(-1).group, 'public-rescue');
  assert.deepEqual(
    spent.at(-1).buckets.map(b => [b.identity.split(':')[0], b.limit, b.windowMs]),
    [
      ['ip', 20, 900000],
      ['rescue-token', 5, 900000],
      ['rescue-token-day', 20, 86400000],
    ],
  );
  assert.equal(spent.at(-1).buckets[1].identity, 'rescue-token:tok-a');
});

test('Core labels every route it serves or proxies by template, and nothing else', () => {
  const labels = {
    '/api/pets': '/api/pets',
    '/api/pets/abc': '/api/pets/:id',
    '/api/appointments/abc/status': '/api/appointments/:id/status',
    '/api/appointments/calendar': '/api/appointments/calendar',
    '/api/appointments/abc/reminder': '/api/appointments/:id/reminder',
    '/api/medical-records/images': '/api/medical-records/images',
    '/api/medical-records/images/abc': '/api/medical-records/images/:id',
    '/api/medical-records/abc/history': '/api/medical-records/:id/history',
    '/api/notifications/unread-count': '/api/notifications/unread-count',
    '/api/notifications/abc/read': '/api/notifications/:id/read',
    '/api/invoices/abc/pay': '/api/invoices/:id/pay',
    '/api/hotel-bookings/abc/daily-care': '/api/hotel-bookings/:id/daily-care',
    '/api/owners/abc/activation': '/api/owners/:id/activation',
    '/api/auth/owner/login': '/api/auth/owner/login',
    '/api/auth/me/password': '/api/auth/me/password',
    '/api/dashboard/clinic': '/api/dashboard/clinic',
    '/api/public/rescue/tok': '/api/public/rescue/:token',
    '/api/public/rescue/tok/report': '/api/public/rescue/:token', // the label has never carried the /report suffix
    '/api/public/pets/tok': '/api/public/pets/:token',
    '/api/public/pets/tok/rescue-reports': '/api/public/pets/:token/rescue-reports',
    '/api/dashboard/clinic/activity': undefined,
    '/api/medical-records/images/abc/restore': undefined,
    '/api/unknown/abc': undefined,
    '/api/pets/abc/def/ghi': undefined,
    '/health/ready': undefined,
  };
  for (const [path, label] of Object.entries(labels)) assert.equal(coreRouteLabel(path), label, path);
  assert.equal(
    coreRouteLabel('/api/pets/' + 'a'.repeat(201)),
    undefined,
    'an id longer than 200 characters is not a template',
  );
});
