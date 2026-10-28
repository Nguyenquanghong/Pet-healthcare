import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mountDirectory } from '../dist/src/phase2/directoryApi.js';
import { signToken, verifyToken, issuedBeforePasswordChange } from '../dist/src/lib/token.js';
import { ownerDto, petDto } from '../dist/src/lib/serialize.js';

// Core's directory handler: the check order, the response bodies and the query plan (D).
const credential = 'directory-api-fixture-'.padEnd(40, 'x');
for (const key of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_KEY_ID']) delete process.env[key];
process.env.JWT_SECRET = randomBytes(32).toString('hex');

const person = (id, role, extra = {}) => ({ id, role, fullName: 'Name ' + id, username: null, phone: '', email: null, address: null, avatarUrl: null, createdAt: new Date(0), updatedAt: new Date(0), passwordHash: 'h', passwordSalt: 's', directoryRevision: 3, passwordChangedAt: null, ...extra });
const pet = (id, ownerId) => ({ id, ownerId, name: 'Pet ' + id, species: 'dog', breed: null, gender: 'unknown', ageLabel: null, weightKg: null, microchipId: null, avatarUrl: null, healthStatus: 'healthy', allergies: [], notes: null, identifyingMarks: null, lastSeenLocation: null, qrToken: null, qrEnabled: true, showOwnerPhone: true, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: true, rescueNote: null, directoryRevision: 2 });
const users = [person('o1', 'owner'), person('o2', 'owner'), person('s1', 'staff'), person('a1', 'admin'), person('d1', 'doctor'), person('x1', 'staff')];
const pets = [pet('p1', 'o1'), pet('p2', 'o2'), pet('p3', 'x1')]; // p3's owner is not an owner account
const personSelect = { id: true, username: true, phone: true, email: true, fullName: true, role: true, address: true, avatarUrl: true, createdAt: true, updatedAt: true, passwordHash: true, passwordSalt: true, directoryRevision: true };

// A database double that logs every query. It answers the legacy `id in (...)` owner filter and the batch one.
function store({ rows = users, fail = false } = {}) {
  const log = [];
  const record = (name, args) => { log.push({ name, args }); if (fail) throw new Error('database down'); };
  const owned = (u, clause) => clause.id ? clause.id.in.includes(u.id) : pets.some(p => p.ownerId === u.id && clause.pets.some.id.in.includes(p.id));
  const db = {
    log,
    user: {
      findUnique: async args => { record('user.findUnique', args); const u = rows.find(r => r.id === args.where.id); return u ? { id: u.id, role: u.role, fullName: u.fullName, passwordChangedAt: u.passwordChangedAt } : null; },
      findFirst: async args => { record('user.findFirst', args); const u = rows.find(r => r.id === args.where.id && r.role === args.where.role); return u ? { id: u.id, fullName: u.fullName } : null; },
      findMany: async args => { record('user.findMany', args); const w = args.where; return rows.filter(u => u.role === w.role && (!w.id || w.id.in.includes(u.id)) && (!w.OR || w.OR.some(c => owned(u, c)))); },
    },
    pet: { findMany: async args => { record('pet.findMany', args); return pets.filter(p => args.where.id.in.includes(p.id)); } },
    $transaction: async (work, options) => { log.push({ name: '$transaction', form: Array.isArray(work) ? 'batch' : 'callback', options }); return Array.isArray(work) ? Promise.all(work) : work(db); },
  };
  return db;
}
// The sequential implementation D replaced, kept as the oracle for status and body.
async function reference(db, actor, bearer, data) {
  const petIds = [...new Set(data.petIds ?? [])], ownerIds = [...new Set(data.ownerIds ?? [])];
  return db.$transaction(async tx => {
    const sender = await tx.user.findUnique({ where: { id: actor.sub }, select: { id: true, role: true, fullName: true, passwordChangedAt: true } });
    if (!sender || sender.role !== actor.role) return { status: 403, error: 'Actor permission changed.' };
    if (issuedBeforePasswordChange(bearer, sender.passwordChangedAt)) return { status: 401, error: 'Password changed. Sign in again.', code: 'SESSION_REVOKED' };
    const found = await tx.pet.findMany({ where: { id: { in: petIds } } });
    if (found.length !== petIds.length) return { status: 404, error: 'Pet not found.' };
    if (actor.role === 'owner' && (found.some(p => p.ownerId !== actor.sub) || ownerIds.some(id => id !== actor.sub))) return { status: 403, error: 'Owner scope required.' };
    const doctor = data.doctorId ? await tx.user.findFirst({ where: { id: data.doctorId, role: 'doctor' }, select: { id: true, fullName: true } }) : null;
    if (data.doctorId && !doctor) return { status: 422, error: 'Doctor not found.' };
    const allOwnerIds = [...new Set([...ownerIds, ...found.map(p => p.ownerId)])];
    const owners = await tx.user.findMany({ where: { id: { in: allOwnerIds }, role: 'owner' }, select: personSelect });
    if (owners.length !== allOwnerIds.length) return { status: 404, error: 'Owner not found.' };
    return { status: 200, actor: { sub: sender.id, role: sender.role, fullName: sender.fullName }, pets: found.map(p => ({ ...petDto(p), directoryVersion: p.directoryRevision })), owners: owners.map(u => ({ ...ownerDto(u), directoryVersion: u.directoryRevision })), ...(doctor ? { doctor } : {}) };
  }, { isolationLevel: 'RepeatableRead' });
}

const holder = { db: null };
const delegate = path => (...args) => path.reduce((value, key) => value[key], holder.db)(...args);
const proxy = { user: { findUnique: delegate(['user', 'findUnique']), findFirst: delegate(['user', 'findFirst']), findMany: delegate(['user', 'findMany']) }, pet: { findMany: delegate(['pet', 'findMany']) }, $transaction: delegate(['$transaction']) };
const app = express();
mountDirectory(app, proxy, credential);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

async function ask(body, { as = 's1', role, rows, fail, token, service = credential, path = 'authorize' } = {}) {
  const db = store({ rows, fail }); holder.db = db;
  const bearer = token ?? signToken(as, role ?? users.find(u => u.id === as)?.role ?? 'staff');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/internal/directory/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': service, authorization: 'Bearer ' + bearer }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json(), db, bearer };
}
const sortOwners = body => body.owners ? { ...body, owners: [...body.owners].sort((a, b) => a.id.localeCompare(b.id)) } : body;
const queryNames = db => db.log.map(entry => entry.name);
const emptyIn = value => value && typeof value === 'object' && (Array.isArray(value.in) && value.in.length === 0 || Object.values(value).some(emptyIn));

test('check order: actor changed, revoked session, pet, owner scope, doctor, owner; every failure at once resolves to the first', async () => {
  const revoked = users.map(u => u.id === 's1' ? { ...u, passwordChangedAt: new Date(Date.now() + 60000) } : u);
  const table = [
    ['actor deleted (also bad pet, doctor, owner)', { petIds: ['ghost'], ownerIds: ['ghost'], doctorId: 'ghost' }, { as: 's1', rows: users.filter(u => u.id !== 's1') }, 403, 'Actor permission changed.'],
    ['actor role changed since the token', { petIds: ['ghost'], doctorId: 'ghost' }, { as: 's1', role: 'admin' }, 403, 'Actor permission changed.'],
    ['revoked session (also bad pet and doctor)', { petIds: ['ghost'], doctorId: 'ghost' }, { as: 's1', rows: revoked }, 401, 'Password changed. Sign in again.'],
    ['unknown pet (also foreign scope and bad doctor)', { petIds: ['p2', 'ghost'], ownerIds: ['o2'], doctorId: 'ghost' }, { as: 'o1' }, 404, 'Pet not found.'],
    ['owner asks a foreign pet (also bad doctor)', { petIds: ['p2'], doctorId: 'ghost' }, { as: 'o1' }, 403, 'Owner scope required.'],
    ['owner asks a foreign owner id', { ownerIds: ['o2'] }, { as: 'o1' }, 403, 'Owner scope required.'],
    ['unknown doctor (also unknown owner)', { petIds: ['p1'], ownerIds: ['ghost'], doctorId: 'ghost' }, { as: 's1' }, 422, 'Doctor not found.'],
    ['a staff account is not a doctor', { doctorId: 's1' }, { as: 's1' }, 422, 'Doctor not found.'],
    ['unknown owner id', { petIds: ['p1'], ownerIds: ['ghost'] }, { as: 's1' }, 404, 'Owner not found.'],
    ['pet whose owner is not an owner account', { petIds: ['p3'] }, { as: 's1' }, 404, 'Owner not found.'],
  ];
  for (const [name, request, options, status, error] of table) {
    const actual = await ask(request, options), actor = verifyToken(actual.bearer);
    assert.equal(actual.status, status, name + ' ' + JSON.stringify(actual.body));
    assert.equal(actual.body.error, error, name);
    if (status === 401) assert.equal(actual.body.code, 'SESSION_REVOKED', name);
    // Same answer as the sequential implementation on a fresh copy of the same data.
    const expected = await reference(store({ rows: options.rows }), actor, actual.bearer, request), { status: expectedStatus, ...expectedBody } = expected;
    assert.deepEqual({ status: actual.status, body: actual.body }, { status: expectedStatus, body: JSON.parse(JSON.stringify(expectedBody)) }, name);
  }
});

test('identical bodies to the sequential implementation on success; owners follow the requested order', async () => {
  const table = [
    ['staff, two pets, owners, doctor', { petIds: ['p1', 'p2'], ownerIds: ['o2', 'o1'], doctorId: 'd1' }, { as: 's1' }],
    ['owner, own pet', { petIds: ['p1'] }, { as: 'o1' }],
    ['owner, own owner id only', { ownerIds: ['o1'] }, { as: 'o1' }],
    ['admin, duplicate ids', { petIds: ['p1', 'p1'], ownerIds: ['o1', 'o1'] }, { as: 'a1' }],
    ['doctor lookup only', { doctorId: 'd1' }, { as: 's1' }],
    ['nothing named', {}, { as: 'o2' }],
    ['lookup endpoint shares the handler', { petIds: ['p2'] }, { as: 's1', path: 'lookup' }],
  ];
  for (const [name, request, options] of table) {
    const actual = await ask(request, options), actor = verifyToken(actual.bearer);
    assert.equal(actual.status, 200, name + ' ' + JSON.stringify(actual.body));
    const { status, ...expectedBody } = await reference(store(), actor, actual.bearer, request);
    assert.deepEqual(sortOwners(actual.body), sortOwners(JSON.parse(JSON.stringify(expectedBody))), name);
  }
  const ordered = await ask({ petIds: ['p1', 'p2'], ownerIds: ['o2'] }, { as: 's1' });
  assert.deepEqual(ordered.body.owners.map(o => o.id), ['o2', 'o1'], 'ids named first, then the pets\' owners');
});

test('query plan: nothing named is one plain read; otherwise one RepeatableRead batch with no empty IN list', async () => {
  const plain = await ask({}, { as: 's1' });
  assert.deepEqual(queryNames(plain.db), ['user.findUnique'], 'no transaction, no pet or owner query');
  const named = [
    ['pets', { petIds: ['p1'] }, ['user.findUnique', 'pet.findMany', 'user.findMany', '$transaction']],
    ['owners', { ownerIds: ['o1'] }, ['user.findUnique', 'user.findMany', '$transaction']],
    ['doctor', { doctorId: 'd1' }, ['user.findUnique', 'user.findFirst', '$transaction']],
    ['everything', { petIds: ['p1'], ownerIds: ['o1'], doctorId: 'd1' }, ['user.findUnique', 'pet.findMany', 'user.findFirst', 'user.findMany', '$transaction']],
  ];
  for (const [name, request, expected] of named) {
    const { db, status } = await ask(request, { as: 's1' });
    assert.equal(status, 200, name);
    assert.deepEqual(queryNames(db), expected, name);
    const transaction = db.log.find(entry => entry.name === '$transaction');
    assert.equal(transaction.form, 'batch', name);
    assert.deepEqual(transaction.options, { isolationLevel: 'RepeatableRead' }, name);
    assert.ok(!db.log.some(entry => emptyIn(entry.args)), name + ': no query with an empty IN list');
  }
});

test('input and credential checks stay before the database; a database failure is a 503 without detail', async () => {
  for (const [name, body] of [['unknown key', { nope: 1 }], ['petIds not a list', { petIds: 'p1' }], ['too many ids', { petIds: Array.from({ length: 101 }, (_, i) => 'p' + i) }], ['empty doctor id', { doctorId: '' }]]) {
    const actual = await ask(body, { as: 's1' });
    assert.equal(actual.status, 422, name);
    assert.deepEqual(actual.db.log, [], name + ': nothing queried');
  }
  const forged = await ask({}, { as: 's1', service: 'wrong-service-credential'.padEnd(40, 'y') });
  assert.equal(forged.status, 401);assert.deepEqual(forged.db.log, []);
  const anonymous = await ask({}, { token: 'not-a-token' });
  assert.equal(anonymous.status, 401);assert.equal(anonymous.body.error, 'Invalid actor context.');assert.deepEqual(anonymous.db.log, []);
  for (const body of [{}, { petIds: ['p1'] }]) {
    const failed = await ask(body, { as: 's1', fail: true });
    assert.equal(failed.status, 503);assert.deepEqual(failed.body, { error: 'Core directory unavailable.' });
  }
});
