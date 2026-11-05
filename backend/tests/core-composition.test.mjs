import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createCoreApp } from '../dist/src/composition/coreApp.js';
import { servesClinical } from '../dist/src/composition/config.js';
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

test('createCoreDomains({ clinical: false }) mounts neither the appointment nor the medical-record router', async () => {
  coreTestEnv();
  const token = signToken('admin-1', 'admin');
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

test('createCoreDomains({ clinical: false }) leaves the five clinical GETs out of the list routes and keeps the rest', async () => {
  coreTestEnv();
  const token = signToken('admin-1', 'admin');
  const clinicalLists = [
    '/api/appointments',
    '/api/appointments/calendar?month=2026-11',
    '/api/medical-records',
    '/api/medical-records/images',
    '/api/notifications',
  ];
  const split = createCoreDomains({}, { clinical: false });
  const full = createCoreDomains({});
  for (const path of clinicalLists) {
    assert.equal(await outcome(split, 'GET', path), 404, `GET ${path} without a token`);
    assert.equal(await outcome(split, 'GET', path, token), 404, `GET ${path} with a token`);
    assert.equal(await outcome(full, 'GET', path), 401, `GET ${path} with the clinical list router mounted`);
    // Without a token the prefix guards of /api/appointments and /api/medical-records answer 401 whether or not the list
    // router is mounted. With one, only a mounted router gets past 404 (here it reaches the repository and fails on the empty db).
    assert.notEqual(
      await outcome(full, 'GET', path, token),
      404,
      `GET ${path} with a token reaches the clinical list router`,
    );
  }
  // /api/doctors is served by the Core list router alone: 401 here means that router is mounted and guards it.
  assert.equal(await outcome(split, 'GET', '/api/doctors'), 401, 'the Core list routes stay mounted');
  assert.equal(await outcome(split, 'GET', '/api/hotel-bookings'), 401);
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

// ---- servesClinical: one setting decides what Core mounts -------------------------------------------------------------

test('servesClinical: a process with a Clinic URL does not serve clinical routes, one without does', () => {
  assert.equal(servesClinical({ clinic: null }), true, 'no Clinic URL: Core serves them');
  assert.equal(servesClinical({ clinic: new URL('http://127.0.0.1:1') }), false, 'a Clinic URL: the Clinic service does');
});

const splitEnv = ({ runtime }) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  coreTestEnv();
  if (!runtime) delete process.env.REDIS_URL;
  Object.assign(process.env, {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    JWT_ISSUER: 'composition-fixture',
    JWT_AUDIENCE: 'composition-fixture',
    JWT_KEY_ID: 'fixture',
  });
};
const serviceToken = 'composition-service-credential-'.repeat(2);
// Stands in for the Clinic and Notification services: every request is answered and counted.
async function stubService() {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"marker":"stub"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => stop(server) };
}
// What a database sees in a Core that must not read Clinic's tables: any access to a clinical delegate, any clinical relation
// named anywhere in a query's arguments (an include or a select reads the table too), or raw SQL naming a clinical table, is
// recorded and then throws, so a swallowed error still leaves a trace. Relation names are those of backend/prisma/schema.prisma.
function clinicFreeDb() {
  const touched = [];
  const clinicalDelegates = new Set(['appointment', 'medicalRecord', 'medicalImage', 'notification']);
  const clinicalRelations = new Set([
    ...clinicalDelegates,
    'appointments',
    'doctorAppts',
    'medicalRecords',
    'medicalImages',
    'notifications',
  ]);
  const clinicalTable = /\b(appointments|medical_records|medical_images|notifications)\b/i;
  const forbid = what => {
    touched.push(what);
    throw new Error(`clinical table touched: ${what}`);
  };
  const scan = (where, value) => {
    if (Array.isArray(value)) value.forEach(item => scan(where, item));
    else if (value && typeof value === 'object' && !(value instanceof Date))
      for (const [key, child] of Object.entries(value)) {
        if (clinicalRelations.has(key)) forbid(`${where} names ${key}`);
        scan(where, child);
      }
  };
  const delegate = model =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          method === 'then' || typeof method === 'symbol'
            ? undefined
            : async (args = {}) => {
                scan(`${model}.${String(method)}`, args);
                if (model === 'user' && method === 'findUnique')
                  return { id: args.where.id, role: args.where.id.split('-')[0], passwordChangedAt: null };
                return method === 'count' ? 0 : method === 'findMany' || method === 'groupBy' ? [] : null;
              },
      },
    );
  const db = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'then' || typeof key === 'symbol') return undefined;
        if (clinicalDelegates.has(key)) return forbid(key);
        if (key === '$transaction') return async work => work(db);
        if (/^\$(query|execute)Raw/.test(key))
          return async (query = '') => {
            const text = Array.isArray(query) ? query.join(' ') : String(query.sql ?? query.strings?.join(' ') ?? query);
            if (clinicalTable.test(text)) forbid(`${key} ${text}`);
            return [];
          };
        return delegate(key);
      },
    },
  );
  return { db, touched };
}
const restoreEnv = saved => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
};

// Every operation of backend/openapi.json as admin: [method, concrete path with the base URL].
function operationRequests() {
  const operations = Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.keys(methods)
      .filter(method => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(method => [method.toUpperCase(), path]),
  );
  assert.equal(operations.length, 75, 'backend/openapi.json declares 75 operations');
  return operations.map(([method, path]) => [
    method,
    `${openapi.servers[0].url}${path}`
      .replace('{roomType}', 'standard')
      .replace('{token}', 'tok-1')
      .replace(/\{[^}]+\}/g, 'x-1'),
  ]);
}
async function sweepAsAdmin(base, extra = []) {
  const token = signToken('admin-1', 'admin');
  const statuses = new Map();
  for (const [method, path] of [...operationRequests(), ...extra]) {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'sweep-1' },
      ...(['POST', 'PATCH', 'PUT'].includes(method) ? { body: '{}' } : {}),
    });
    await response.arrayBuffer();
    statuses.set(`${method} ${path}`, response.status);
  }
  return statuses;
}
const clinicalPaths = [
  ['GET', '/api/appointments'],
  ['GET', '/api/appointments/calendar'],
  ['POST', '/api/appointments'],
  ['GET', '/api/medical-records'],
  ['GET', '/api/medical-records/images'],
  ['POST', '/api/medical-records'],
  ['GET', '/api/notifications'],
];

// A Core with a Clinic URL (and a Notification URL), over a database that refuses clinical tables. `runtime` is the
// production shape (REDIS_URL set, createCoreDomains behind the split routes); without it the tail is createApp.
async function splitCore({ runtime }) {
  const saved = { ...process.env };
  const clinic = await stubService();
  const notification = await stubService();
  const { db, touched } = clinicFreeDb();
  splitEnv({ runtime });
  const servers = [];
  let rt;
  const close = async () => {
    rt?.close();
    for (const server of servers) await stop(server);
    await clinic.close();
    await notification.close();
    restoreEnv(saved);
  };
  try {
    const app = createCoreApp(probeAware(db), {
      clinicUrl: clinic.url,
      clinicToken: serviceToken,
      notificationUrl: notification.url,
      notificationToken: serviceToken,
    });
    if (runtime) rt = await localLimiter(app);
    assert.equal(typeof app.locals.domains, 'function', 'createCoreApp keeps the app behind the split routes');
    const listen = async handler => {
      const server = handler.listen(0, '127.0.0.1');
      servers.push(server);
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    };
    return { app, clinic, notification, touched, close, through: () => listen(app), direct: () => listen(app.locals.domains) };
  } catch (error) {
    await close();
    throw error;
  }
}

// Limits of these sweeps: the fake database answers null, [] or 0 and every body is {}, so many deep branches stop at a 400 or
// 404 before they reach a data source. "No clinical table touched" holds for the paths that really ran, not for every branch.
//
// With a Clinic URL the Clinic proxy answers every clinical path before the shared routes, so the flag cannot show in a
// request through createCoreApp. It shows in the shared routes themselves, which the second pass reaches by sending the same
// requests to the app behind the split routes (app.locals.domains) straight: there the clinical paths must be plain 404s and
// no request may read a clinical table.
test('split Core (Clinic URL, runtime, RSA) answers all 75 operations as admin without touching a clinical table', async () => {
  const core = await splitCore({ runtime: true });
  try {
    const through = await sweepAsAdmin(await core.through());
    assert.deepEqual(core.touched, [], 'through the gateway: no request reached a clinical table');
    assert.equal(through.get('GET /api/pets'), 200, 'a Core list is read through the database that refuses clinical tables');
    assert.ok(core.clinic.calls.includes('GET /api/appointments'), 'the Clinic prefixes went to the Clinic service');
    assert.ok(core.notification.calls.includes('GET /api/notifications'), 'the notification routes went to Notification');

    const direct = await sweepAsAdmin(await core.direct());
    assert.deepEqual(core.touched, [], 'on the domains app: no request reached a clinical table');
    assert.equal(direct.get('GET /api/pets'), 200);
    for (const [method, path] of clinicalPaths)
      assert.equal(direct.get(`${method} ${path}`), 404, `${method} ${path} is not a Core route`);
  } finally {
    await core.close();
  }
});

// The same without REDIS_URL: createCoreApp then mounts createApp(db, { clinical }), the monolith's entrypoint, behind the split
// routes. It also serves /api/bootstrap, whose repository must not read the clinical or notification tables either.
test('split Core without a runtime (createApp behind a Clinic URL) serves no clinical route and reads no clinical table', async () => {
  const core = await splitCore({ runtime: false });
  try {
    await sweepAsAdmin(await core.through());
    assert.deepEqual(core.touched, [], 'through the gateway: no request reached a clinical table');
    assert.ok(core.clinic.calls.includes('GET /api/appointments'), 'the Clinic prefixes went to the Clinic service');

    const direct = await sweepAsAdmin(await core.direct(), [['GET', '/api/bootstrap']]);
    assert.deepEqual(core.touched, [], 'on createApp: no request reached a clinical table');
    assert.equal(direct.get('GET /api/pets'), 200);
    assert.equal(direct.get('GET /api/bootstrap'), 200, 'the monolith dashboard is served, from Core tables only');
    for (const [method, path] of clinicalPaths)
      assert.equal(direct.get(`${method} ${path}`), 404, `${method} ${path} is not a Core route`);
  } finally {
    await core.close();
  }
});

// Appointment billing is mounted by mountSplitRoutes for a Clinic URL, and only there. A request of type 'appointment' is
// refused by that route alone, so a configuration that stops serving clinical routes without it would answer 404.
test('servesClinical is false exactly where appointment billing is mounted', async () => {
  const saved = { ...process.env };
  const clinic = await stubService();
  try {
    for (const clinicUrl of [undefined, clinic.url]) {
      splitEnv({ runtime: true });
      const config = clinicUrl ? { clinicUrl, clinicToken: serviceToken } : {};
      const { db } = clinicFreeDb();
      const app = createCoreApp(probeAware(db), config);
      const rt = await localLimiter(app);
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/op-1`);
        const mounted = response.status === 401;
        assert.ok(mounted || response.status === 404, `GET /api/operations/op-1 answered ${response.status}`);
        assert.equal(mounted, !servesClinical({ clinic: clinicUrl ? new URL(clinicUrl) : null }), String(clinicUrl));
      } finally {
        rt.close();
        await stop(server);
      }
    }
  } finally {
    await clinic.close();
    restoreEnv(saved);
  }
});
