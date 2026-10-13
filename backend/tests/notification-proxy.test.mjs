import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCoreApp } from '../dist/src/phase2/coreApp.js';
import { signToken } from '../dist/src/lib/token.js';

test('Notification proxy preserves retry/degraded headers and status without leaking private headers', async () => {
  const saved = { ...process.env };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  delete process.env.REDIS_URL; delete process.env.PHASE2_RUNTIME_REQUIRED;
  Object.assign(process.env, {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    JWT_ISSUER: 'proxy-fixture', JWT_AUDIENCE: 'proxy-fixture', JWT_KEY_ID: 'fixture',
  });
  let status = 429, received;
  const downstream = createServer((req, res) => {
    received = req.headers;
    res.writeHead(status, {
      'Content-Type': 'application/json', 'Retry-After': '7',
      'X-Service-Degraded': 'redis', 'X-Service-Instance': 'replica-1',
      'X-Service-Token': 'private-fixture', 'Set-Cookie': 'internal=private',
    });
    res.end(status === 204 ? undefined : JSON.stringify({ error: 'Fixture response' }));
  }).listen(0, '127.0.0.1');
  let core;
  try {
    await once(downstream, 'listening');
    const db = { user: { findUnique: async () => ({ id: 'fixture', role: 'owner' }) } };
    core = createCoreApp(db, {
      notificationUrl: `http://127.0.0.1:${downstream.address().port}`,
      notificationToken: 'fixture-service-credential-'.repeat(2),
    }).listen(0, '127.0.0.1');
    await once(core, 'listening');
    const token = signToken('fixture', 'owner');
    for (status of [429, 503, 200, 204]) {
      const res = await fetch(`http://127.0.0.1:${core.address().port}/api/notifications/unread-count`, {
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'fixture-key', 'X-Service-Token': 'untrusted-client-value' },
      });
      assert.equal(res.status, status);
      assert.equal(res.headers.get('retry-after'), '7', `Retry-After lost for HTTP ${status}`);
      assert.equal(res.headers.get('x-service-degraded'), 'redis');
      assert.equal(res.headers.get('x-service-instance'), 'notification:replica-1');
      assert.equal(res.headers.get('x-service-token'), null);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(received.authorization, `Bearer ${token}`);
      assert.equal(received['idempotency-key'], 'fixture-key');
      assert.equal(received['x-service-token'], undefined);
      if (status === 204) assert.equal(await res.text(), '');
      else assert.equal((await res.json()).error, 'Fixture response');
    }
  } finally {
    if (core) await new Promise(resolve => core.close(resolve));
    await new Promise(resolve => downstream.close(resolve));
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
