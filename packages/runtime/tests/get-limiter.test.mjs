import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { MemoryWindows, ServiceRuntime } from '../dist/index.js';

// P-limiter: GET reads are counted in memory per instance; sign-in, public pages and every write keep Redis.
const snapshot = { pending: 0, outboxAgeSeconds: 0, outboxRetries: 0, billingPending: 0, billingAgeSeconds: 0, dbLockWaits: 0 };
const bucket = (identity, limit, windowMs = 60000) => ({ identity, limit, windowMs });

test('MemoryWindows: limit, check-all-then-increment, Retry-After and window reset', () => {
  let now = 1000;
  const windows = new MemoryWindows(100, () => now);
  const buckets = [bucket('ip:a', 3), bucket('actor:x', 2)];
  assert.deepEqual(windows.spend('g', buckets), { allowed: true, remaining: 1, retryMs: 0, limit: 2 });
  assert.equal(windows.spend('g', buckets).remaining, 0);
  now += 10000;
  const denied = windows.spend('g', buckets);
  assert.deepEqual(denied, { allowed: false, remaining: 0, retryMs: 50000, limit: 2 });
  assert.equal(windows.spend('g', [bucket('ip:a', 3)]).remaining, 0, 'a denied request spent nothing from the ip bucket (2 of 3 used, this is the 3rd)');
  assert.equal(windows.spend('g', [bucket('ip:a', 3)]).allowed, false);
  assert.equal(windows.spend('other', [bucket('ip:a', 3)]).allowed, true, 'groups do not share windows');
  now += 49999;
  assert.equal(windows.spend('g', buckets).allowed, false, 'still inside the window');
  now += 1;
  assert.deepEqual(windows.spend('g', buckets), { allowed: true, remaining: 1, retryMs: 0, limit: 2 }, 'the window reset');
});

test('MemoryWindows: expired windows are dropped and the map never grows past its cap', () => {
  let now = 0;
  const windows = new MemoryWindows(20, () => now);
  for (let i = 0; i < 20; i++) windows.spend('g', [bucket('actor:' + i, 5)]);
  assert.equal(windows.size, 20);
  now += 60001;
  windows.spend('g', [bucket('actor:fresh', 5)]);
  assert.equal(windows.size, 1, 'the 20 expired windows were swept');
  for (let i = 0; i < 500; i++) {
    windows.spend('g', [bucket('actor:flood-' + i, 5), bucket('ip:' + i, 5)]);
    assert.ok(windows.size <= 20, 'bounded at ' + windows.size);
  }
  assert.equal(windows.size, 20);
  // The oldest windows went first: the newest client is still counted, the first one was forgotten.
  assert.equal(windows.spend('g', [bucket('actor:flood-499', 1)]).allowed, false);
  assert.equal(windows.spend('g', [bucket('actor:flood-0', 1)]).allowed, true);
  assert.throws(() => new MemoryWindows(5), /INVALID_LIMIT_POLICY/);
  assert.throws(() => windows.spend('g', []), /INVALID_LIMIT_POLICY/);
  assert.throws(() => windows.spend('g', [bucket('x', 0)]), /INVALID_LIMIT_POLICY/);
});

async function harness(t, env = {}) {
  Object.assign(process.env, {
    OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
    RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
    REDIS_URL: 'redis://127.0.0.1:1',
    RATE_LIMIT_NAMESPACE: 'get-limiter-test',
  }, env);
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; });
  const rt = new ServiceRuntime({ service: 'clinic', verify: token => ({ sub: token, role: 'owner' }), probe: async () => snapshot });
  const redis = { calls: [], down: false };
  rt.limiter.spend = async (group, buckets) => {
    redis.calls.push({ group, buckets });
    if (redis.down) throw new Error('REDIS_UNAVAILABLE');
    return { allowed: true, remaining: 99, retryMs: 0, limit: 100 };
  };
  rt.limiter.ping = async () => true;
  rt.brokerProbe = async () => true;
  await rt.start();
  const app = express();
  rt.install(app);
  const ok = (_req, res) => res.json({ ok: true });
  app.all('/api/items', ok);
  app.all('/api/auth/me', ok);
  app.all('/api/auth/owner/activation/inspect', ok);
  app.all('/api/public/pets/:token', ok);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { rt.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const call = (path, { method = 'GET', token = 'owner-a' } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: token ? { authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(1500) });
  return { rt, redis, call };
}

test('a GET read never calls Redis; a write does', async t => {
  const { rt, redis, call } = await harness(t);
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/items')).status, 200);
  assert.equal((await call('/api/items', { method: 'HEAD' })).status, 200);
  assert.equal(redis.calls.length, 0, 'ten GETs and a HEAD cost no Redis call');
  assert.equal((await call('/api/items', { method: 'POST' })).status, 200);
  assert.equal(redis.calls.length, 1);
  assert.equal(redis.calls[0].group, 'clinic-write');
  assert.equal((await call('/api/items', { method: 'DELETE' })).status, 200);
  assert.equal(redis.calls.length, 2);
  assert.match(rt.metrics(), /pet_limiter_local_total\{service="clinic"\} 11\n/);
});

test('sign-in, activation and public pages keep the shared limiter for GET too', async t => {
  const { redis, call } = await harness(t);
  for (const path of ['/api/auth/me', '/api/AUTH/me', '/api/auth/owner/activation/inspect?token=x', '/api/public/pets/qr-1', '/api/Public/pets/qr-1'])
    assert.equal((await call(path)).status, 200, path);
  assert.equal(redis.calls.length, 5, 'every one of them spent from Redis');
  assert.ok(redis.calls.every(c => c.group === 'clinic-read'));
  assert.equal((await call('/api/items')).status, 200);
  assert.equal(redis.calls.length, 5, 'an ordinary read still does not');
});

test('Redis down: reads keep working, writes fail closed, shared GETs degrade as before', async t => {
  const { redis, call } = await harness(t);
  redis.down = true;
  const read = await call('/api/items');
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('x-service-degraded'), null, 'an ordinary read is not degraded: it never needed Redis');
  const write = await call('/api/items', { method: 'POST' });
  assert.equal(write.status, 503);
  assert.equal(write.headers.get('retry-after'), '2');
  assert.match((await write.json()).error, /Rate limit authority unavailable/);
  const shared = await call('/api/auth/me');
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get('x-service-degraded'), 'redis');
});

test('GET limits keep their keys, headers and 429 shape; each client has its own budget', async t => {
  const { redis, call } = await harness(t, { API_READ_ACTOR_LIMIT: '3' });
  const remaining = [];
  for (let i = 0; i < 3; i++) {
    const res = await call('/api/items', { token: 'owner-a' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ratelimit-limit'), '3');
    remaining.push(res.headers.get('ratelimit-remaining'));
  }
  assert.deepEqual(remaining, ['2', '1', '0']);
  const denied = await call('/api/items', { token: 'owner-a' });
  assert.equal(denied.status, 429);
  assert.deepEqual(await denied.json(), { error: 'Too many requests. Retry after the indicated delay.' });
  assert.ok(Number(denied.headers.get('retry-after')) >= 1 && Number(denied.headers.get('retry-after')) <= 60);
  assert.equal(denied.headers.get('ratelimit-remaining'), '0');
  assert.equal((await call('/api/items', { token: 'owner-b' })).status, 200, 'another actor has its own window');
  assert.equal(redis.calls.length, 0);
});

test('the in-memory table is bounded by LOCAL_LIMITER_MAX_ENTRIES', async t => {
  const { rt, call } = await harness(t, { LOCAL_LIMITER_MAX_ENTRIES: '16' });
  for (let i = 0; i < 60; i++) assert.equal((await call('/api/items', { token: 'owner-' + i })).status, 200);
  assert.ok(rt.limiter.memory.size <= 16, 'bounded at ' + rt.limiter.memory.size);
  rt.close();
  assert.equal(rt.limiter.memory.size, 0, 'closing releases the table');
});
