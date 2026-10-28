import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { acceptsCredential, actorVerifier, databaseUrl, prismaClient, serviceOrigin } from '../dist/index.js';

// The hand-written comparison Core and Clinic used before they shared acceptsCredential.
const legacy = (value, expected) =>
  !(
    typeof value !== 'string' ||
    value.length > 512 ||
    !timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(expected).digest())
  );

test('acceptsCredential accepts and rejects exactly what the inline copies did', () => {
  const secret = 's'.repeat(40),
    longest = 'x'.repeat(512);
  const values = [secret, secret + 'x', secret.slice(1), '', ' ', secret.toUpperCase(), longest, longest + 'x', [secret], [secret, secret], 42, null, undefined, {}, true];
  for (const expected of [secret, longest, ''])
    for (const value of values)
      assert.equal(acceptsCredential(value, expected), legacy(value, expected), `${String(value).slice(0, 12)} vs ${expected.length}`);
  assert.equal(acceptsCredential(secret, secret), true);
  assert.equal(acceptsCredential(longest, longest), true);
  assert.equal(acceptsCredential(longest + 'x', longest + 'x'), false, 'over 512 characters is never accepted');
  assert.equal(acceptsCredential([secret], secret), false, 'a repeated header is not a credential');
  assert.equal(acceptsCredential('', ''), true, 'only the callers decide an empty expected value is unusable');
});

test('serviceOrigin returns an http(s) origin and otherwise throws the call site error code', () => {
  for (const ok of ['http://core:5100', 'https://core.example', 'http://127.0.0.1:5101/', 'http://[::1]:3000']) {
    const url = serviceOrigin(ok, 'BAD');
    assert.ok(url instanceof URL);
    assert.equal(url.href, new URL(ok).href);
  }
  assert.equal(serviceOrigin(new URL('http://core:5100'), 'BAD').origin, 'http://core:5100');
  for (const bad of ['ftp://core', 'ws://core', 'http://core/x', 'http://core/api/', 'http://core?x=1', 'http://core/#a', 'http://user@core', 'http://user:pw@core', 'http://:pw@core', 'core:5100', 'not a url', '', '/relative'])
    assert.throws(() => serviceOrigin(bad, 'INVALID_SERVICE_URL_FIXTURE'), error => error instanceof Error && error.message === 'INVALID_SERVICE_URL_FIXTURE', bad);
});

function withEnv(env, run) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const apply = values => {
    for (const [k, v] of Object.entries(values)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  apply(env);
  try {
    return run();
  } finally {
    apply(saved);
  }
}

test('prismaClient passes the pooled datasource URL only when the Phase 2 runtime is on', () => {
  class Client {
    constructor(options) {
      this.options = options;
    }
  }
  const url = 'postgresql://user:pw@db:5432/app';
  assert.equal(withEnv({ PHASE2_RUNTIME_REQUIRED: undefined, REDIS_URL: undefined, DATABASE_URL: url }, () => prismaClient(Client)).options, undefined);
  withEnv({ PHASE2_RUNTIME_REQUIRED: '1', REDIS_URL: undefined, DATABASE_URL: url }, () => {
    assert.deepEqual(prismaClient(Client).options, { datasourceUrl: databaseUrl() });
  });
  assert.throws(() => withEnv({ PHASE2_RUNTIME_REQUIRED: '1', REDIS_URL: undefined, DATABASE_URL: undefined }, () => prismaClient(Client)), /DATABASE_CONFIGURATION_REQUIRED/);
});

test('actorVerifier pins the key id from JWT_KEY_ID when it is set', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'test-core', audience: 'pet-api' };
  const sign = keyid =>
    jwt.sign({ role: 'owner' }, keys.privateKey, { algorithm: 'RS256', issuer: 'test-core', audience: 'pet-api', subject: 'owner-id', expiresIn: '1h', ...(keyid ? { keyid } : {}) });
  withEnv({ JWT_KEY_ID: undefined }, () => {
    const verify = actorVerifier(config);
    assert.deepEqual(verify(sign()), { sub: 'owner-id', role: 'owner' });
    assert.deepEqual(verify(sign('other')), { sub: 'owner-id', role: 'owner' });
  });
  withEnv({ JWT_KEY_ID: 'key-1' }, () => {
    const verify = actorVerifier(config);
    assert.deepEqual(verify(sign('key-1')), { sub: 'owner-id', role: 'owner' });
    assert.throws(() => verify(sign('other')), /INVALID_ACTOR/);
    assert.throws(() => verify(sign()), /INVALID_ACTOR/);
  });
  withEnv({ JWT_KEY_ID: 'bad key!' }, () => assert.throws(() => actorVerifier(config), /INVALID_AUTH_CONFIGURATION/));
});
