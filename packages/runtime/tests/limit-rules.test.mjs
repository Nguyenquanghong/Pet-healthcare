import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { ServiceRuntime, createRuntime } from '../dist/index.js';

// The runtime knows no business route: the service passes its limit rules, body limits and route labels in.
const snapshot = { pending: 0, outboxAgeSeconds: 0, outboxRetries: 0, billingPending: 0, billingAgeSeconds: 0, dbLockWaits: 0 };
const verify = () => ({ sub: 'owner', role: 'owner' });
function environment(t, env = {}) {
  Object.assign(
    process.env,
    {
      OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
      RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
      REDIS_URL: 'redis://127.0.0.1:1',
      RATE_LIMIT_NAMESPACE: 'limit-rules-test',
    },
    env,
  );
  t.after(() => {
    for (const key of Object.keys(env)) delete process.env[key];
  });
}
async function harness(t, options = {}, env = {}) {
  environment(t, env);
  const rt = new ServiceRuntime({ service: 'clinic', verify, probe: async () => snapshot, ...options });
  const spent = [];
  // localRead has the same check-all-then-increment semantics as the Redis script.
  rt.limiter.spend = async (group, buckets) => {
    spent.push({ group, buckets });
    return rt.limiter.localRead(group, buckets);
  };
  rt.limiter.ping = async () => true;
  rt.brokerProbe = async () => true;
  await rt.start();
  const app = express();
  rt.install(app);
  let reached = 0;
  app.all('/api/*splat', express.json({ limit: '1mb' }), (_req, res) => {
    reached++;
    res.status(201).json({ ok: true });
  });
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: 'refused' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    rt.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const send = (path, init = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', signal: AbortSignal.timeout(1500), ...init });
  return { rt, send, spent, reached: () => reached };
}

test('createRuntime refuses to start a service that left limitRules out; an empty list is an explicit choice', t => {
  environment(t, { PHASE2_RUNTIME_REQUIRED: '1' });
  assert.throws(() => createRuntime({ service: 'core', verify, probe: async () => snapshot }), /LIMIT_RULES_REQUIRED/);
  assert.throws(() => createRuntime({ service: 'core', verify, probe: async () => snapshot, limitRules: undefined }), /LIMIT_RULES_REQUIRED/);
  assert.throws(() => createRuntime({ service: 'core', verify, probe: async () => snapshot, limitRules: 'auth' }), /LIMIT_RULES_REQUIRED/);
  const runtime = createRuntime({ service: 'core', verify, probe: async () => snapshot, limitRules: [] });
  assert.ok(runtime instanceof ServiceRuntime);
  runtime.close();
});

test('with no rules the general limit still applies: the runtime has no sign-in rule of its own', async t => {
  const { send, spent, reached } = await harness(t, { limitRules: [] }, { API_WRITE_IP_LIMIT: '2' });
  for (let i = 0; i < 2; i++) assert.equal((await send('/api/auth/owner/login')).status, 201);
  const denied = await send('/api/auth/owner/login');
  assert.equal(denied.status, 429);
  assert.equal(reached(), 2, 'a refused request never reaches the handler');
  assert.deepEqual(new Set(spent.map(s => s.group)), new Set(['clinic-write']), 'no auth-login group without a rule');
  assert.deepEqual(spent[0].buckets.map(b => [b.identity.split(':')[0], b.limit, b.windowMs]), [['ip', 2, 60000]], 'no token, so the per-ip bucket only');
});

test('the first rule that answers decides, a rule that passes falls through, a failing rule fails closed', async t => {
  const calls = [];
  const rules = [
    () => (calls.push('a'), undefined),
    ({ req, ip, bucket, limit }) => (calls.push('b'), req.path === '/special' ? { group: 'special', read: false, buckets: [bucket(ip, limit('SPECIAL_LIMIT', 1), 60000)] } : undefined),
    () => (calls.push('c'), undefined),
  ];
  const { send, spent } = await harness(t, { limitRules: rules });
  assert.equal((await send('/api/special')).status, 201);
  assert.equal((await send('/api/special')).status, 429);
  assert.deepEqual(spent.map(s => s.group), ['special', 'special']);
  assert.deepEqual(calls, ['a', 'b', 'a', 'b'], 'rule c was never asked once b answered');
  assert.equal((await send('/api/other')).status, 201);
  assert.equal(spent.at(-1).group, 'clinic-write', 'no rule answered: the general policy');
});

test('an invalid threshold read by a rule fails closed with 503 instead of disabling the limiter', async t => {
  const rule = ({ ip, bucket, limit }) => ({ group: 'g', read: false, buckets: [bucket(ip, limit('RULE_TEST_LIMIT', 5))] });
  const { send, reached } = await harness(t, { limitRules: [rule] }, { RULE_TEST_LIMIT: '0' });
  assert.equal((await send('/api/x')).status, 503);
  assert.equal(reached(), 0);
});

test('general({ shared: true }) keeps a read on the shared limiter; other reads stay per instance', async t => {
  const sharedReads = ({ req, general }) => (req.path.startsWith('/open') ? general({ shared: true }) : undefined);
  const { send, spent } = await harness(t, { limitRules: [sharedReads] });
  assert.equal((await send('/api/open/page', { method: 'GET' })).status, 201);
  assert.deepEqual(spent.map(s => s.group), ['clinic-read'], 'shared: Redis was asked');
  assert.equal((await send('/api/closed/page', { method: 'GET' })).status, 201);
  assert.equal(spent.length, 1, 'per instance: no Redis round trip');
});

test('bodyLimits parse JSON before the limiter, so a rule can read it, and cap its size; without them nothing is parsed', async t => {
  const byWho = ({ req, ip, bucket }) => (req.body?.who ? { group: 'who:' + req.body.who, read: false, buckets: [bucket(ip, 100, 60000)] } : undefined);
  const withLimit = await harness(t, { limitRules: [byWho], bodyLimits: [{ path: '/api/secure', limit: '1kb' }] });
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await withLimit.send('/api/secure/in', json({ who: 'ann' }))).status, 201);
  assert.equal(withLimit.spent.at(-1).group, 'who:ann');
  assert.equal((await withLimit.send('/api/secure/in', json({ who: 'x'.repeat(2000) }))).status, 413, 'over the 1kb limit');
  assert.equal((await withLimit.send('/api/elsewhere/in', json({ who: 'bob' }))).status, 201);
  assert.equal(withLimit.spent.at(-1).group, 'clinic-write', 'only the configured path is parsed first');
  const without = await harness(t, { limitRules: [byWho] });
  assert.equal((await without.send('/api/secure/in', json({ who: 'ann' }))).status, 201);
  assert.equal(without.spent.at(-1).group, 'clinic-write', 'the runtime parses no body by itself');
});

test('metric labels come from the service; the runtime labels only its own endpoints, and anything else is unknown', async t => {
  const routeLabel = p => (/^\/api\/pets\/[^/]{1,200}$/.test(p) ? '/api/pets/:id' : undefined);
  const labelled = await harness(t, { limitRules: [], routeLabel });
  for (const path of ['/api/pets/p1?x=1', '/api/pets/p2', '/api/health', '/api/other/o1', '/internal/anything', '/health/live']) await labelled.send(path, { method: 'GET' });
  const routes = [...labelled.rt.metrics().matchAll(/pet_http_duration_seconds_count\{[^}]*route="([^"]+)"[^}]*\} (\d+)/g)].map(m => m[1]).sort();
  assert.deepEqual(routes, ['/api/health', '/api/pets/:id', '/health/live', '/internal/:scope', 'unknown'], 'ids never become labels');
  const unlabelled = await harness(t, { limitRules: [] });
  await unlabelled.send('/api/pets/p1', { method: 'GET' });
  assert.match(unlabelled.rt.metrics(), /route="unknown"/);
  assert.doesNotMatch(unlabelled.rt.metrics(), /route="\/api\/pets/);
});
