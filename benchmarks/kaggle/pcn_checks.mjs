import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "../../backend/dist/src/lib/password.js";
import { signToken, verifyToken } from "../../backend/dist/src/lib/token.js";

const database = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !database.pathname.endsWith('_test')) {
  throw new Error('PCN checks require an isolated loopback database whose name ends in _test.');
}
const mode = process.argv[2];
const fixture = JSON.parse(await readFile(process.env.BENCH_FIXTURE, 'utf8'));
const client = new PrismaClient();
const base = process.env.PCN_API || 'http://127.0.0.1:5001/api';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('API must be loopback.');

async function request(method, path, token, body) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
async function save(value) {
  await writeFile(process.env.PCN_CHECK_OUTPUT, JSON.stringify(value, null, 2));
}
async function snapshot(ids) {
  const records = await client.pet.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
  return JSON.parse(JSON.stringify(records));
}

try {
  if (mode === 'seed') {
    const password = process.env.BENCH_PASSWORD;
    const admin = await client.user.create({ data: { fullName: 'PCN synthetic admin', username: 'pcn-admin', role: 'admin', ...hashPassword(password) } });
    // The baseline booking UI currently submits this doctor ID. Keep it explicit
    // in the isolated fixture; it does not modify any application database.
    await client.user.create({ data: { id: 'doctor_mai', fullName: 'PCN fixture doctor', role: 'doctor', ...hashPassword(password) } });
    fixture.adminToken = signToken(admin.id, 'admin');
    for (const user of fixture.users) {
      user.ownerId = verifyToken(user.token).sub;
      const appointment = await client.appointment.create({ data: {
        ownerId: user.ownerId, petId: user.petId, type: 'general_checkup', serviceName: 'Synthetic existing visit',
        clinicName: 'Synthetic clinic', appointmentDate: new Date('2098-01-01'), appointmentTime: '09:00',
      } });
      user.appointmentId = appointment.id;
      const record = await client.medicalRecord.create({ data: {
        ownerId: user.ownerId, petId: user.petId, doctorName: 'Synthetic doctor', visitDate: new Date('2026-01-01'),
        title: 'Synthetic record', diagnosis: 'Synthetic diagnosis', treatment: 'Synthetic treatment',
      } });
      user.medicalRecordId = record.id;
      const notice = await client.notification.create({ data: {
        recipientOwnerId: user.ownerId, recipientRole: 'owner', type: 'pcn_fixture', title: 'Synthetic private notice', message: 'Synthetic message',
      } });
      user.notificationId = notice.id;
      const hotel = await client.hotelBooking.create({ data: {
        ownerId: user.ownerId, petId: user.petId, checkIn: new Date('2098-02-01'), checkOut: new Date('2098-02-02'),
        roomType: 'standard', status: 'confirmed', serviceKeys: [], nights: 1, totalAmount: 200000,
      } });
      user.hotelBookingId = hotel.id;
      const invoice = await client.invoice.create({ data: {
        invoiceCode: `PCN-${user.petId}`, type: 'hotel_booking', ownerId: user.ownerId, petId: user.petId,
        hotelBookingId: hotel.id, subtotal: 200000, totalAmount: 200000, paymentStatus: 'unpaid',
        items: { create: { description: 'Synthetic one-night stay', unitPrice: 200000, quantity: 1, amount: 200000 } },
      } });
      user.invoiceId = invoice.id;
    }
    await writeFile(process.env.BENCH_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
    await save({ owners: fixture.users.length, synthetic: true, doctor_fixture_id: 'doctor_mai' });
  } else if (mode === 'security') {
    const [owner, other] = fixture.users;
    const checks = [];
    const add = (name, passed, details = {}) => checks.push({ name, passed: Boolean(passed), ...details });
    const users = await client.user.findMany();
    const hashed = users.filter(user => user.passwordHash !== process.env.BENCH_PASSWORD && user.passwordSalt
      && verifyPassword(process.env.BENCH_PASSWORD, user.passwordHash, user.passwordSalt)).length;
    add('Every synthetic account stores a verifiable salted hash instead of plaintext', hashed === users.length,
      { checked_accounts: users.length, valid_hashed_accounts: hashed });
    for (const path of ['/pets', '/appointments', '/medical-records', '/hotel-bookings', '/invoices', '/notifications', '/bootstrap']) {
      const result = await request('GET', path);
      add(`Anonymous GET ${path}`, result.status === 401, { expected: 401, actual: result.status });
    }
    const invalid = await request('GET', '/pets', 'invalid.token.value');
    add('Invalid JWT rejected', invalid.status === 401, { expected: 401, actual: invalid.status });
    for (const [path, key] of [['/pets', 'ownerId'], ['/appointments', 'ownerId'], ['/medical-records', 'ownerId']]) {
      const result = await request('GET', `${path}?ownerId=${other.ownerId}`, owner.token);
      add(`Owner cannot use foreign ownerId to read ${path}`, result.status === 200 && Array.isArray(result.body)
        && result.body.every(row => row[key] === owner.ownerId), { actual: result.status });
    }
    const cases = [
      ['PATCH', `/pets/${other.petId}`, { name: 'Denied change' }],
      ['POST', '/appointments', { petId: other.petId, type: 'general_checkup', serviceName: 'Denied', date: '2099-12-01', time: '09:00' }],
      ['PATCH', `/appointments/${other.appointmentId}/cancel`, {}],
      ['PATCH', `/medical-records/${other.medicalRecordId}`, { title: 'Denied change' }],
      ['DELETE', `/medical-records/${other.medicalRecordId}`, undefined],
      ['PATCH', `/notifications/${other.notificationId}/read`, {}, 404],
      ['POST', '/notifications/send', { recipientOwnerId: other.ownerId, title: 'Denied', message: 'Denied' }],
      ['POST', '/owners', { fullName: 'Denied customer', phone: '0901112233' }],
    ];
    for (const [method, path, body, expected = 403] of cases) {
      const result = await request(method, path, owner.token, body);
      add(`${method} ${path.replace(other.petId, '{foreign-pet}').replace(other.appointmentId, '{foreign-appointment}').replace(other.medicalRecordId, '{foreign-record}').replace(other.notificationId, '{foreign-notification}')}`,
        result.status === expected, { expected, actual: result.status });
    }
    const before = await client.pet.findUnique({ where: { id: other.petId } });
    add('Denied write did not modify foreign pet', before.name !== 'Denied change');
    await save({ passed: checks.every(x => x.passed), checks, tested_case_count: checks.length,
      scope: 'All accounts in the synthetic test DB; explicitly listed access matrix, not every possible attack.' });
  } else if (mode === 'create-records') {
    const ids = [];
    for (let index = 0; index < 20; index++) {
      const result = await request('POST', '/pets', fixture.users[0].token, {
        name: `PCN persistence ${index}`, species: index % 2 ? 'cat' : 'dog', breed: 'Synthetic breed',
        gender: 'unknown', weightKg: 3 + index / 10, allergies: ['Synthetic allergy'], notes: `Synthetic note ${index}`,
      });
      if (result.status !== 201 || !result.body?.pet?.id) throw new Error(`Could not save persistence record ${index}: HTTP ${result.status}`);
      ids.push(result.body.pet.id);
    }
    const records = await snapshot(ids);
    await writeFile(process.env.PCN_SNAPSHOT, JSON.stringify({ ids, records }), { mode: 0o600 });
    await save({ count: ids.length, created_via_api: true });
  } else if (mode === 'verify-records') {
    const saved = JSON.parse(await readFile(process.env.PCN_SNAPSHOT, 'utf8'));
    const current = await snapshot(saved.ids);
    const passed = saved.ids.length === 20 && current.length === 20 && isDeepStrictEqual(saved.records, current);
    await save({ count: current.length, passed, comparison: 'Every persisted field, including ID, timestamps, notes and owner, matched exactly.' });
  } else {
    throw new Error('Unknown PCN check mode');
  }
} finally {
  await client.$disconnect();
}
