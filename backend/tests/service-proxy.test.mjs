import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createCoreApp } from '../dist/src/phase2/coreApp.js';
import { signToken } from '../dist/src/lib/token.js';

// P08 part A: the Core gateway forwards Clinic and Notification routes. These
// tests pin what the client sees, so the shared proxy keeps the old behaviour.
const credential = 'fixture-service-credential-'.repeat(2);
const listen = async server => { await once(server.listen(0, '127.0.0.1'), 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise(resolve => server.close(resolve));

async function gateway(env, run) {
  const saved = { ...process.env };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  delete process.env.REDIS_URL; delete process.env.PHASE2_RUNTIME_REQUIRED;
  Object.assign(process.env, {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    JWT_ISSUER: 'proxy-fixture', JWT_AUDIENCE: 'proxy-fixture', JWT_KEY_ID: 'fixture', ...env,
  });
  const state = { reply: () => ({ status: 200, body: { ok: true } }), calls: [] };
  const downstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    state.calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    const { status, body, headers = {}, text, hang } = state.reply(req);
    if (hang) return;
    res.writeHead(status, { 'Content-Type': text === undefined ? 'application/json' : 'text/html', ...headers });
    res.end(status === 204 ? undefined : text ?? JSON.stringify(body));
  });
  let core;
  try {
    const origin = await listen(downstream);
    const db = { user: { findUnique: async () => ({ id: 'fixture', role: 'admin', passwordChangedAt: null }) } };
    core = createCoreApp(db, { clinicUrl: origin, clinicToken: credential, notificationUrl: origin, notificationToken: credential }).listen(0, '127.0.0.1');
    await once(core, 'listening');
    const base = `http://127.0.0.1:${core.address().port}`;
    const token = signToken('fixture', 'admin');
    await run({ base, token, state, stopDownstream: () => { downstream.closeAllConnections(); return close(downstream); } });
  } finally {
    if (core) { core.closeAllConnections(); await close(core); }
    if (downstream.listening) { downstream.closeAllConnections(); await close(downstream); }
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

// The path goes out as written; a URL string would resolve the dot segments first.
const rawGet = (base, path, token) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(base);
  const req = httpRequest({ hostname, port, path, headers: { Authorization: `Bearer ${token}` } }, res => {
    let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  });
  req.on('error', reject); req.end();
});

test('Clinic routes: allowed headers go both ways, body and status pass through, private headers never do', async () => {
  await gateway({}, async ({ base, token, state }) => {
    state.reply = () => ({ status: 409, body: { error: 'Fixture conflict', code: 'MEDICAL_RECORD_STALE' }, headers: {
      'X-Service-Instance': 'replica-1', 'X-Service-Degraded': 'clinic', 'Retry-After': '2', 'X-Clinic-Read-Token': 'read-token',
      'X-Clinic-Read-Source': 'authoritative', 'X-Clinic-Projection-Generation': 'g1', 'Cache-Control': 'no-store',
      'X-Service-Token': 'private-fixture', 'Set-Cookie': 'internal=private' } });
    const res = await fetch(base + '/api/medical-records/r1', { method: 'PATCH', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1', 'X-Clinic-Min-Version': 'v1',
      'X-Clinic-Read-Consistency': 'strong', 'X-Service-Token': 'untrusted-client-value', Cookie: 'session=private' }, body: JSON.stringify({ title: 'T', expectedRevision: 3 }) });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'Fixture conflict', code: 'MEDICAL_RECORD_STALE' });
    assert.equal(res.headers.get('x-service-instance'), 'clinic:replica-1');
    for (const [name, value] of [['x-service-degraded', 'clinic'], ['retry-after', '2'], ['cache-control', 'no-store']]) assert.equal(res.headers.get(name), value, name);
    for (const name of ['x-clinic-read-token', 'x-clinic-read-source', 'x-clinic-projection-generation']) assert.equal(res.headers.get(name), null, name + ' is no longer a Clinic response header');
    assert.equal(res.headers.get('x-service-token'), null);
    assert.equal(res.headers.get('set-cookie'), null);
    const [call] = state.calls;
    assert.equal(call.method, 'PATCH'); assert.equal(call.url, '/api/medical-records/r1');
    assert.deepEqual(JSON.parse(call.body), { title: 'T', expectedRevision: 3 });
    assert.equal(call.headers['content-type'], 'application/json');
    for (const [name, value] of [['authorization', `Bearer ${token}`], ['idempotency-key', 'key-1']]) assert.equal(call.headers[name], value, name);
    assert.equal(call.headers['x-clinic-min-version'], undefined); assert.equal(call.headers['x-clinic-read-consistency'], undefined);
    assert.equal(call.headers['x-service-token'], undefined); assert.equal(call.headers.cookie, undefined);
    state.reply = () => ({ status: 204 });
    const deleted = await fetch(base + '/api/medical-records/r1?expectedRevision=4', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(deleted.status, 204); assert.equal(await deleted.text(), '');
    assert.equal(state.calls.at(-1).url, '/api/medical-records/r1?expectedRevision=4');
  });
});

test('Clinic and Notification routes refuse paths that leave their prefix', async () => {
  await gateway({}, async ({ base, token, state }) => {
    for (const [path, error] of [['/api/appointments/%2e%2e/internal/directory/export', 'Clinic route not found.'], ['/api/notifications/%2e%2e/internal/x', 'Notification route not found.']]) {
      const res = await rawGet(base, path, token);
      assert.equal(res.status, 404, path); assert.equal(res.body.error, error);
    }
    assert.equal(state.calls.length, 0);
  });
});

test('a dead downstream answers 503 with the retry message of its service', async () => {
  await gateway({}, async ({ base, token, stopDownstream }) => {
    await stopDownstream();
    for (const [path, error] of [['/api/appointments', 'Clinic service unavailable. Retry the same request key.'], ['/api/notifications', 'Notification service unavailable. Retry the same request key.']]) {
      const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 503, path); assert.equal((await res.json()).error, error);
    }
  });
});

test('Clinic breaker: repeated 5xx opens it and fails fast; after the open window one probe closes it', async () => {
  await gateway({ CLINIC_GATEWAY_BREAKER_FAILURES: '3', CLINIC_GATEWAY_BREAKER_OPEN_MS: '300' }, async ({ base, token, state }) => {
    const get = () => fetch(base + '/api/appointments', { headers: { Authorization: `Bearer ${token}` } });
    state.reply = () => ({ status: 503, body: { error: 'Clinic unavailable. Retry the same request key.' }, headers: { 'X-Service-Instance': 'replica-1' } });
    for (let i = 0; i < 3; i++) {
      const res = await get();
      assert.equal(res.status, 503); assert.equal((await res.json()).error, 'Clinic unavailable. Retry the same request key.', 'the downstream answer reaches the client');
      assert.equal(res.headers.get('x-service-instance'), 'clinic:replica-1');
    }
    const started = performance.now(), open = await get(), elapsed = performance.now() - started;
    assert.equal(open.status, 503); assert.equal((await open.json()).error, 'Clinic service unavailable. Retry the same request key.');
    assert.equal(open.headers.get('retry-after'), '1'); assert.equal(open.headers.get('x-service-degraded'), 'clinic');
    assert.equal(state.calls.length, 3, 'an open circuit does not call Clinic'); assert.ok(elapsed < 250, `fails fast (${elapsed} ms)`);
    // The Notification circuit is separate.
    state.reply = () => ({ status: 200, body: { unread: 0 } });
    assert.equal((await fetch(base + '/api/notifications/unread-count', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 350));
    const probe = await get();
    assert.equal(probe.status, 200); assert.equal(state.calls.length, 5);
    assert.equal((await get()).status, 200, 'a good probe closes the circuit');
  });
});

test('business answers and deliberate degradation never open the Clinic circuit', async () => {
  await gateway({ CLINIC_GATEWAY_BREAKER_FAILURES: '2' }, async ({ base, token, state }) => {
    const get = () => fetch(base + '/api/appointments', { headers: { Authorization: `Bearer ${token}` } });
    for (const status of [401, 403, 404, 409, 422, 401, 403, 404, 409, 422]) { state.reply = () => ({ status, body: { error: 'Business' } }); assert.equal((await get()).status, status); }
    state.reply = () => ({ status: 503, body: { error: 'Projection busy' }, headers: { 'X-Service-Degraded': 'projection', 'Retry-After': '1' } });
    for (let i = 0; i < 4; i++) { const res = await get(); assert.equal(res.status, 503); assert.equal((await res.json()).error, 'Projection busy'); assert.equal(res.headers.get('x-service-degraded'), 'projection'); }
    state.reply = () => ({ status: 200, body: { items: [] } });
    assert.equal((await get()).status, 200);
    assert.equal(state.calls.length, 15, 'every request reached Clinic');
  });
});

test('a downstream body that is not JSON is a 502 with a code, not an outage', async () => {
  await gateway({}, async ({ base, token, state }) => {
    state.reply = () => ({ status: 200, text: '<html>proxy error page</html>' });
    for (const path of ['/api/appointments', '/api/notifications']) {
      const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 502, path); assert.equal((await res.json()).code, 'DOWNSTREAM_INVALID_RESPONSE');
    }
  });
});
