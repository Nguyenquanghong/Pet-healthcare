import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { deniedMessage } from '@nipopeto/contracts';
import { mountNotificationAuthorization } from '../dist/src/composition/internalRoutes.js';
import { signToken } from '../dist/src/lib/token.js';

// Core's authorize-send handler: the order of the checks, the response bodies and the two sequential account reads.
const credential = 'send-authorization-fixture-'.padEnd(40, 'x');
for (const key of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_KEY_ID']) delete process.env[key];
process.env.JWT_SECRET = randomBytes(32).toString('hex');

const users = [
  { id: 's1', role: 'staff' },
  { id: 'a1', role: 'admin' },
  { id: 'd1', role: 'doctor' },
  { id: 'o1', role: 'owner' },
  { id: 'o2', role: 'owner' },
];

// A database double that logs the id of every account read; `failOn` is the 1-based read that throws.
function store({ rows = users, failOn } = {}) {
  const log = [];
  return {
    log,
    user: {
      findUnique: async args => {
        log.push(args.where.id);
        if (log.length === failOn) throw new Error('database down');
        const row = rows.find(r => r.id === args.where.id);
        return row ? { id: row.id, role: row.role } : null;
      },
    },
  };
}

const holder = { db: null };
const proxy = { user: { findUnique: (...args) => holder.db.user.findUnique(...args) } };
const listen = async app => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};
// The body parser's refusals reach the app's error handler; Core's own handler sits above this route, so a bare one stands in.
const app = credential => {
  const target = express();
  mountNotificationAuthorization(target, proxy, credential);
  target.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.type }));
  return target;
};
const shortCredential = 'x'.repeat(31);
const servers = [await listen(app(credential)), await listen(app(undefined)), await listen(app(shortCredential))];
test.after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

async function ask(
  body,
  { as = 's1', role, rows, failOn, bearer, service = credential, raw, target = servers[0] } = {},
) {
  const db = store({ rows, failOn });
  holder.db = db;
  const token = bearer === undefined ? 'Bearer ' + signToken(as, role ?? users.find(u => u.id === as)?.role ?? 'staff') : bearer;
  const res = await fetch(`http://127.0.0.1:${target.address().port}/internal/notifications/authorize-send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(service ? { 'x-service-token': service } : {}),
      ...(token ? { authorization: token } : {}),
    },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text.startsWith('{') ? JSON.parse(text) : undefined, reads: db.log };
}

test('check order: credential, service token, bearer, permission matrix, shape, sender, recipient', async () => {
  const bad = { recipientOwnerId: 5 };
  const table = [
    ['no credential configured (also wrong token, no bearer, bad shape)', bad, { target: servers[1], service: 'wrong', bearer: '' }, 503, 'Internal authorization unavailable.', 0],
    ['credential of 31 characters, presented correctly', { recipientOwnerId: 'o1' }, { target: servers[2], service: shortCredential }, 503, 'Internal authorization unavailable.', 0],
    ['wrong service token (also no bearer, bad shape)', bad, { service: 'wrong', bearer: '' }, 401, 'Service authentication required.', 0],
    ['no service token', { recipientOwnerId: 'o1' }, { service: '' }, 401, 'Service authentication required.', 0],
    ['no bearer (also bad shape)', bad, { bearer: '' }, 401, 'Invalid actor context.', 0],
    ['Basic scheme', { recipientOwnerId: 'o1' }, { bearer: 'Basic abc' }, 401, 'Invalid actor context.', 0],
    ['bearer of 8200 characters', { recipientOwnerId: 'o1' }, { bearer: 'Bearer ' + 'a'.repeat(8200) }, 401, 'Invalid actor context.', 0],
    ['owner is refused by the matrix before the shape is read', bad, { as: 'o1' }, 403, deniedMessage('notification.send'), 0],
    ['doctor is refused by the matrix before the shape is read', {}, { as: 'd1' }, 403, deniedMessage('notification.send'), 0],
    ['bad shape from staff (also missing sender)', bad, { as: 's1', rows: [] }, 422, 'Invalid recipient request.', 0],
    ['sender deleted (also missing recipient)', { recipientOwnerId: 'ghost' }, { as: 's1', rows: [] }, 403, 'Staff access is required.', 1],
    ['sender role changed since the token (also missing recipient)', { recipientOwnerId: 'ghost' }, { as: 's1', role: 'admin' }, 403, 'Staff access is required.', 1],
    ['recipient missing', { recipientOwnerId: 'ghost' }, {}, 404, 'Recipient not found.', 2],
    ['recipient is not an owner', { recipientOwnerId: 'a1' }, {}, 404, 'Recipient not found.', 2],
  ];
  for (const [name, body, options, status, error, reads] of table) {
    const actual = await ask(body, options);
    assert.equal(actual.status, status, name + ' ' + actual.text);
    assert.equal(actual.body.error, error, name);
    assert.equal(actual.reads.length, reads, name + ': account reads');
  }
});

test('the sender is read first, then the recipient', async () => {
  const { status, reads } = await ask({ recipientOwnerId: 'o2' }, { as: 'a1' });
  assert.equal(status, 200);
  assert.deepEqual(reads, ['a1', 'o2']);
});

test('shape: every body that is not exactly one recipient id is a 422', async () => {
  const shapes = [
    ['array', undefined, '[]'],
    ['no recipient', {}],
    ['recipient a number', { recipientOwnerId: 5 }],
    ['recipient empty', { recipientOwnerId: '' }],
    ['recipient 201 characters', { recipientOwnerId: 'o'.repeat(201) }],
    ['extra key', { recipientOwnerId: 'o1', title: 'x' }],
  ];
  for (const [name, body, raw] of shapes) {
    const actual = await ask(body, { raw });
    assert.equal(actual.status, 422, name);
    assert.deepEqual(actual.body, { error: 'Invalid recipient request.' }, name);
  }
  assert.equal((await ask({ recipientOwnerId: 'o'.repeat(200) })).status, 404, '200 characters is still a lookup');
});

test('the body is parsed before the credential: broken JSON and 9 kb are refused whatever the token', async () => {
  assert.equal((await ask(undefined, { service: 'wrong', raw: '{' })).status, 400);
  assert.equal((await ask(undefined, { raw: '{' })).status, 400);
  assert.equal((await ask({ recipientOwnerId: 'o'.repeat(9 * 1024) })).status, 413);
});

test('success bodies keep their keys and order; a database failure on either read is a 503', async () => {
  for (const [as, role] of [['s1', 'staff'], ['a1', 'admin']]) {
    const actual = await ask({ recipientOwnerId: 'o1' }, { as });
    assert.equal(actual.status, 200);
    assert.equal(actual.text, JSON.stringify({ actorId: as, actorRole: role, recipientOwnerId: 'o1', authorized: true }));
  }
  for (const failOn of [1, 2]) {
    const actual = await ask({ recipientOwnerId: 'o1' }, { failOn });
    assert.equal(actual.status, 503, 'read ' + failOn);
    assert.deepEqual(actual.body, { error: 'Core authorization unavailable.' }, 'read ' + failOn);
    assert.equal(actual.reads.length, failOn, 'no read after the one that failed');
  }
});
