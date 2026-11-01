import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createCoreApp } from '../dist/src/composition/coreApp.js';
import { createCoreDomains } from '../dist/src/composition/coreDomains.js';
import { hashPassword } from '../dist/src/lib/password.js';
import { signToken } from '../dist/src/lib/token.js';
import { coreTestEnv, localLimiter, probeAware } from './core-composition-helper.mjs';

// The routes Core keeps when Clinic and Notification are separate services, served by the production composition
// (createCoreApp with the real runtime, limiter on its local fallback) over a fake database. Clinical routes stay in
// http-contracts and http-appointments, which run the Phase 1 app.
const openapi = await SwaggerParser.validate(
  JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')),
);
function validateSchema(schema, value, location = 'response') {
  if (schema.$ref) return validateSchema(openapi.components.schemas[schema.$ref.split('/').at(-1)], value, location);
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${location} must be array`);
    value.forEach((item, index) => validateSchema(schema.items, item, `${location}[${index}]`));
  } else if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${location} must be object`);
    for (const field of schema.required || []) assert.ok(Object.hasOwn(value, field), `${location}.${field} required`);
    for (const [field, child] of Object.entries(schema.properties || {})) {
      if (value[field] !== undefined && value[field] !== null)
        validateSchema(child, value[field], `${location}.${field}`);
    }
  } else if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), `${location} must be integer`);
  } else if (schema.type) {
    assert.equal(typeof value, schema.type, `${location} type`);
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} enum`);
}
function validateResponse(path, method, status, body) {
  const basePath = openapi.servers[0].url;
  assert.ok(path.startsWith(`${basePath}/`), `${path} must use the API base URL`);
  const schema =
    openapi.paths[path.slice(basePath.length)][method.toLowerCase()].responses[String(status)].content?.[
      'application/json'
    ]?.schema;
  assert.ok(schema, `${method} ${path} needs a JSON response schema`);
  validateSchema(schema, body, `${method} ${path}`);
}

const stop = server => {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
};
async function boot(client) {
  coreTestEnv();
  const app = createCoreApp(probeAware(client), {});
  const rt = await localLimiter(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', token, body, raw) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body || raw ? { 'content-type': 'application/json' } : {}),
      },
      ...(body || raw ? { body: raw ?? JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    request,
    close: async () => {
      rt.close();
      await stop(server);
    },
  };
}

const password = hashPassword('owner-password');
const owner = (id = 'owner-1', role = 'owner') => ({
  id,
  username: null,
  phone: '123',
  email: 'owner@example.test',
  fullName: 'Owner',
  role,
  address: null,
  avatarUrl: null,
  passwordChangedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...password,
});
const pet = {
  id: 'pet-1',
  ownerId: 'owner-1',
  name: 'Mochi',
  species: 'dog',
  breed: null,
  gender: 'unknown',
  ageLabel: null,
  weightKg: null,
  microchipId: null,
  healthStatus: 'healthy',
  allergies: [],
  notes: null,
  avatarUrl: null,
  identifyingMarks: null,
  lastSeenLocation: null,
  qrToken: 'qr-1',
  qrEnabled: true,
  showOwnerPhone: true,
  showOwnerEmail: false,
  showOwnerAddress: false,
  showMedicalAlerts: true,
  rescueNote: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
// Only the tables Core owns: a clinical or notification delegate is missing, so a query against one fails the request.
function coreClient(writes) {
  const account = id => owner(id, id.split('-')[0]);
  const client = {
    user: {
      findFirst: async () => owner(),
      findUnique: async ({ where }) => account(where.id),
      findMany: async () => [{ ...owner(), pets: [{ id: pet.id }] }],
    },
    pet: {
      findMany: async () => [pet],
      findFirst: async () => ({ ...pet, owner: owner() }),
      findUnique: async () => pet,
    },
    hotelBooking: { findMany: async () => [] },
    dailyCareNote: { findMany: async () => [] },
    outboxEvent: {
      create: async ({ data }) => {
        writes.push({ kind: 'outbox', data });
        return data;
      },
    },
    invoice: { findMany: async () => [] },
    rescueReport: {
      create: async ({ data }) => {
        writes.push({ kind: 'report', data });
        return { id: 'r-1', ...data };
      },
      findFirst: async () => null,
    },
    $transaction: async work => work(client),
    $queryRaw: async () => [{ '?column?': 1 }],
  };
  for (const name of ['user', 'pet', 'hotelBooking', 'dailyCareNote', 'invoice']) {
    client[name].count = async () => (['user', 'pet'].includes(name) ? 1 : 0);
    client[name].groupBy = async () => [];
  }
  return client;
}

test('the routes Core keeps keep their JSON, auth and method contracts', async () => {
  const writes = [];
  const core = await boot(coreClient(writes));
  try {
    const login = await core.request('/api/auth/owner/login', 'POST', undefined, {
      email: 'owner@example.test',
      password: 'owner-password',
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, 'owner-1');
    assert.ok(login.body.token);
    validateResponse('/api/auth/owner/login', 'POST', 200, login.body);
    const ownerToken = login.body.token;

    for (const path of [
      '/api/health',
      '/api/auth/me',
      '/api/pets',
      '/api/hotel-bookings',
      '/api/invoices',
      '/api/public/pets/qr-1',
    ]) {
      const result = await core.request(
        path,
        'GET',
        path.startsWith('/api/public') || path === '/api/health' ? undefined : ownerToken,
      );
      assert.equal(result.status, 200, path);
      validateResponse(path === '/api/public/pets/qr-1' ? '/api/public/pets/{token}' : path, 'GET', 200, result.body);
    }

    const rescue = await core.request('/api/public/pets/qr-1/rescue-reports', 'POST', undefined, {
      finderPhone: '000',
      location: 'Park',
    });
    assert.equal(rescue.status, 201);
    validateResponse('/api/public/pets/{token}/rescue-reports', 'POST', 201, rescue.body);
    assert.deepEqual(
      writes.map(item => item.kind),
      ['report', 'outbox'],
    );
    assert.equal(writes.at(-1).data.envelope.eventType, 'notification.requested.v1');
    assert.equal(writes.at(-1).data.envelope.payload.recipientOwnerId, 'owner-1');
  } finally {
    await core.close();
  }
});

test('Core serves neither /api/bootstrap nor the notification routes itself', async () => {
  const writes = [];
  const core = await boot(coreClient(writes));
  try {
    const ownerToken = signToken('owner-1', 'owner');
    const bootstrap = await core.request('/api/bootstrap', 'GET', ownerToken);
    assert.equal(bootstrap.status, 404);
    assert.match(bootstrap.body.error, /not found/);

    const list = await core.request('/api/notifications', 'GET', ownerToken);
    assert.equal(list.status, 503);
    assert.equal(list.body.error, 'Notification service is not configured.');

    const sent = await core.request('/api/notifications/send', 'POST', signToken('staff-1', 'staff'), {
      recipientOwnerId: 'owner-1',
      title: 'Hi',
      message: 'Message',
    });
    assert.equal(sent.status, 503);
    validateResponse('/api/notifications/send', 'POST', 503, sent.body);
    assert.equal(writes.length, 0, 'a manual send never falls back to a local Notification insert');
  } finally {
    await core.close();
  }
});

test('a malformed JSON body at sign-in is a 400 with the one sentence the gateway uses for every refusal', async () => {
  const core = await boot(coreClient([]));
  try {
    const malformed = await core.request('/api/auth/owner/login', 'POST', undefined, undefined, '{broken');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'Request unavailable or invalid.');
  } finally {
    await core.close();
  }
});

test('createCoreDomains({ clinical: false }) mounts neither the appointment nor the medical-record router', async () => {
  coreTestEnv();
  const token = signToken('admin-1', 'admin');
  const outcome = async (domains, method, path, auth) => {
    const server = domains.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      return response.status;
    } finally {
      await stop(server);
    }
  };
  const clinicalOnly = [
    ['POST', '/api/appointments'],
    ['PATCH', '/api/appointments/a-1/status'],
    ['GET', '/api/appointments/a-1/status-history'],
    ['POST', '/api/medical-records'],
    ['DELETE', '/api/medical-records/m-1'],
    ['GET', '/api/medical-records/m-1/history'],
  ];
  const split = createCoreDomains({}, { clinical: false });
  const full = createCoreDomains({});
  for (const [method, path] of clinicalOnly) {
    assert.equal(await outcome(split, method, path), 404, `${method} ${path} without a token`);
    assert.equal(await outcome(split, method, path, token), 404, `${method} ${path} with a token`);
    assert.equal(await outcome(full, method, path), 401, `${method} ${path} with the routers mounted`);
  }
  assert.equal(await outcome(split, 'POST', '/api/hotel-bookings'), 401, 'the hotel router stays mounted');
  assert.equal(await outcome(split, 'PATCH', '/api/hotel-bookings/h-1/status'), 401);
});

test('the Core dashboard queries no clinical or notification table', async () => {
  const calls = [];
  const db = new Proxy(
    {},
    {
      get: (_target, model) => {
        if (model === 'then' || typeof model === 'symbol') return undefined;
        if (model === '$transaction') return async work => work(db);
        return new Proxy(
          {},
          {
            get: (_models, method) =>
              method === 'then'
                ? undefined
                : async (args = {}) => {
                    calls.push(`${model}.${method}`);
                    if (model === 'user' && method === 'findUnique')
                      return { id: args.where.id, role: args.where.id.split('-')[0], passwordChangedAt: null };
                    return method === 'count' ? 0 : method === 'findMany' || method === 'groupBy' ? [] : null;
                  },
          },
        );
      },
    },
  );
  const clinicalTable = /^(appointment|medicalRecord|medicalImage|notification)\./;
  const core = await boot(db);
  try {
    for (const role of ['admin', 'owner']) {
      calls.length = 0;
      const dashboard = await core.request('/api/dashboard/core', 'GET', signToken(`${role}-1`, role));
      assert.equal(dashboard.status, 200, role);
      assert.ok(dashboard.body.summary, role);
      assert.ok(
        calls.includes('pet.count') && calls.includes('hotelBooking.count'),
        `${role}: Core's own tables are read`,
      );
      assert.deepEqual(
        calls.filter(call => clinicalTable.test(call)),
        [],
        `${role}: no clinical or notification query`,
      );
    }
    // The legacy clinic dashboard is a separate request: it reads appointments, which shows the log would see one.
    calls.length = 0;
    const clinic = await core.request('/api/dashboard/clinic', 'GET', signToken('admin-1', 'admin'));
    assert.equal(clinic.status, 200);
    assert.ok(calls.includes('appointment.count'));
    assert.deepEqual(
      calls.filter(call => call.startsWith('notification.')),
      [],
    );
  } finally {
    await core.close();
  }
});
