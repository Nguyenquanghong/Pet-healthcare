// Fixed-scenario demo data for the split stack (Core, Clinic, Notification) behind the frontend port.
// Accounts are written straight to the Core database, as tools/phase2/e2e-server.mjs does; everything else goes
// through the real API on the user-facing port, so the outbox, the billing saga and Notification all run.
//
// Safety: refuses unless NODE_ENV is not production, the database and API are on this machine, and the Core database
// holds the marker table written by `--mark`. `--mark` is its own deliberate step and only accepts a database that has
// no accounts and no pets yet. Nothing here creates an account on an unmarked database.
//
//   DEV_SEED_DATABASE_URL  Core database reachable from this machine (required)
//   DEV_SEED_API_URL       frontend origin, default http://127.0.0.1:5173
//   DEV_SEED_PASSWORD      shared password of the seeded accounts; otherwise one is generated and written, with the
//                          account names, to test-results/dev-seed/<marker>.json (git-ignored), and printed
//
// A second run changes nothing: every step is recorded in dev_seed_ledger under a fixed key, and is skipped when the
// key is there. The password hash comes from backend/dist/src/lib/password.js, the module the login route verifies
// with, so the hash format cannot drift from it (it needs `npm run build`).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const MARKER_PREFIX = 'pet-dev-seed:v1:';
const DAY = 86400000;

// ---- scenario ---------------------------------------------------------------------------------------------------
const ACCOUNTS = [
  { key: 'admin', role: 'admin', username: 'dev_admin', fullName: 'Lê Thanh Hà', phone: '0281234500' },
  { key: 'doctor', role: 'doctor', username: 'dev_bacsi', fullName: 'BS. Phạm Quốc Việt', phone: '0281234501' },
  { key: 'lananh', role: 'owner', email: 'lananh@example.test', fullName: 'Nguyễn Thị Lan Anh', phone: '0901234561' },
  { key: 'vanhung', role: 'owner', email: 'vanhung@example.test', fullName: 'Trần Văn Hùng', phone: '0912345672' },
  { key: 'ngocmai', role: 'owner', email: 'ngocmai@example.test', fullName: 'Võ Ngọc Mai', phone: '0987654323' },
];
const PETS = [
  { key: 'mochi', owner: 'lananh', name: 'Mochi', species: 'dog', breed: 'Poodle', ageLabel: '2 tuổi', gender: 'male', weightKg: 4.2, healthStatus: 'healthy', allergies: ['Gà'] },
  { key: 'bong', owner: 'lananh', name: 'Bông', species: 'cat', breed: 'Mèo Anh lông ngắn', ageLabel: '3 tuổi', gender: 'female', weightKg: 3.8, healthStatus: 'vaccination_due' },
  { key: 'lucky', owner: 'lananh', name: 'Lucky', species: 'dog', breed: 'Corgi', ageLabel: '1 tuổi', gender: 'male', weightKg: 9.5, healthStatus: 'healthy' },
  { key: 'vang', owner: 'vanhung', name: 'Vàng', species: 'dog', breed: 'Chó Phú Quốc', ageLabel: '4 tuổi', gender: 'male', weightKg: 18.4, healthStatus: 'under_treatment', notes: 'Viêm da mùa nóng, đang bôi thuốc.' },
  { key: 'muop', owner: 'vanhung', name: 'Mướp', species: 'cat', breed: 'Mèo ta', ageLabel: '5 tuổi', gender: 'female', weightKg: 3.1, healthStatus: 'stable' },
  { key: 'kiki', owner: 'vanhung', name: 'Kiki', species: 'rabbit', breed: 'Thỏ Hà Lan', ageLabel: '8 tháng', gender: 'female', weightKg: 1.4, healthStatus: 'healthy' },
  { key: 'sua', owner: 'ngocmai', name: 'Sữa', species: 'cat', breed: 'Mèo Ba Tư', ageLabel: '2 tuổi', gender: 'female', weightKg: 4.5, healthStatus: 'healthy' },
  { key: 'bi', owner: 'ngocmai', name: 'Bi', species: 'dog', breed: 'Golden Retriever', ageLabel: '6 tuổi', gender: 'male', weightKg: 29.8, healthStatus: 'stable', allergies: ['Phấn hoa'] },
  { key: 'tep', owner: 'ngocmai', name: 'Tép', species: 'other', breed: 'Chuột Hamster', ageLabel: '1 tuổi', gender: 'unknown', weightKg: 0.15, healthStatus: 'healthy' },
];
// day: offset from today in Vietnam. steps run in order; see runAppointment for what each one does.
// Exam slots are every 30 minutes from 08:00, Spa starts at 09:00, 10:30, 13:30, 15:00 and 16:30, two places each.
const APPOINTMENTS = [
  { key: 'mochi-checkup', pet: 'mochi', type: 'general_checkup', service: 'Khám tổng quát', day: 3, time: '09:00', ownerNote: 'Bé ăn ít vài hôm nay.', steps: [] },
  { key: 'bong-vaccine', pet: 'bong', type: 'vaccination', service: 'Tiêm phòng dại', day: 2, time: '10:00', steps: ['confirmed'] },
  { key: 'lucky-bath', pet: 'lucky', type: 'spa_bath', service: 'Tắm vệ sinh', day: 0, time: '13:30', steps: ['confirmed', 'checked_in'] },
  { key: 'vang-skin', pet: 'vang', type: 'dermatology', service: 'Khám da liễu', day: 0, time: '14:00', steps: ['confirmed', 'checked_in', 'in_progress'] },
  { key: 'muop-dental', pet: 'muop', type: 'dental', service: 'Lấy cao răng', day: 0, time: '08:30', steps: ['confirmed', 'checked_in', 'in_progress', 'record', 'invoice'] },
  { key: 'kiki-checkup', pet: 'kiki', type: 'general_checkup', service: 'Khám sức khỏe thỏ', day: 1, time: '15:00', steps: ['cancel'] },
  { key: 'sua-combo', pet: 'sua', type: 'spa_combo', service: 'Spa trọn gói', day: 0, time: '15:00', steps: ['confirmed', 'checked_in', 'in_progress', 'completed', 'checkout', 'pay'] },
  { key: 'bi-recheck', pet: 'bi', type: 'general_checkup', service: 'Tái khám', day: 0, time: '08:00', steps: ['confirmed', 'no_show'] },
  { key: 'tep-checkup', pet: 'tep', type: 'other', service: 'Khám tổng quát', day: 4, time: '11:00', steps: ['reschedule'] },
  { key: 'mochi-grooming', pet: 'mochi', type: 'spa_grooming', service: 'Cắt tỉa lông', day: 0, time: '16:30', steps: ['confirmed', 'checked_in', 'in_progress', 'completed', 'checkout', 'onsite'] },
  { key: 'bi-surgery', pet: 'bi', type: 'surgery', service: 'Triệt sản', day: 5, time: '08:00', steps: ['confirmed'] },
];
const HOTEL = [
  { key: 'vang-stay', pet: 'vang', from: 7, to: 10, room: 'standard', services: [], steps: [] },
  { key: 'bi-stay', pet: 'bi', from: 2, to: 5, room: 'deluxe', services: ['daily_walk'], ownerNote: 'Bé quen ăn hạt hai lần mỗi ngày.', steps: ['confirmed'] },
  { key: 'sua-stay', pet: 'sua', from: 0, to: 2, room: 'vip', services: ['video_call'], steps: ['confirmed', 'in_stay', 'note'] },
  { key: 'muop-stay', pet: 'muop', from: 0, to: 1, room: 'standard', services: [], steps: ['confirmed', 'in_stay', 'invoice', 'pay', 'checked_out'] },
  { key: 'lucky-stay', pet: 'lucky', from: 12, to: 14, room: 'standard', services: ['grooming_spa'], steps: ['cancel'] },
  { key: 'kiki-stay', pet: 'kiki', from: 9, to: 10, room: 'standard', services: [], steps: ['rejected'] },
];
const todayInVietnam = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const dayOffset = n => new Date(Date.parse(todayInVietnam() + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// ---- guards -----------------------------------------------------------------------------------------------------
const fail = message => { throw new Error(message); };
const loopback = (value, name) => {
  let host;
  try { host = new URL(value).hostname; } catch { fail(name + ' is not a URL.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) fail(name + ' must point at this machine (127.0.0.1 or localhost); refusing.');
};
const markerQuery = db => db.$queryRawUnsafe('SELECT marker FROM dev_seed_marker').then(rows => rows.map(r => r.marker), () => []);

export async function main(args) {
  const mark = args.includes('--mark');
  if (args.some(a => a !== '--mark')) fail('Usage: node tools/phase2/dev-seed.mjs [--mark]');
  if (process.env.NODE_ENV === 'production') fail('Refusing to run with NODE_ENV=production.');
  const databaseUrl = process.env.DEV_SEED_DATABASE_URL, apiUrl = (process.env.DEV_SEED_API_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
  if (!databaseUrl) fail('Set DEV_SEED_DATABASE_URL to the Core database of a disposable local stack.');
  loopback(databaseUrl, 'DEV_SEED_DATABASE_URL'); loopback(apiUrl, 'DEV_SEED_API_URL');
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const markers = await markerQuery(db);
    if (mark) return await markDatabase(db, markers);
    const marker = markers.find(m => m.startsWith(MARKER_PREFIX));
    if (!marker) fail('This database has no dev-seed marker, so nothing was written. On a fresh disposable stack run `npm run dev:seed -- --mark` first; a database that already holds accounts is never marked.');
    return await seed(db, marker, apiUrl);
  } finally { await db.$disconnect(); }
}

async function markDatabase(db, markers) {
  if (markers.length) fail('This database is already marked; run without --mark to seed it.');
  const [{ accounts, pets }] = await db.$queryRawUnsafe('SELECT (SELECT count(*) FROM users)::int AS accounts, (SELECT count(*) FROM pets)::int AS pets');
  if (accounts || pets) fail(`Refusing to mark a database that already holds ${accounts} account(s) and ${pets} pet(s); only a fresh one is accepted.`);
  const marker = MARKER_PREFIX + randomBytes(4).toString('hex');
  await db.$executeRawUnsafe('CREATE TABLE dev_seed_marker (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
  await db.$executeRawUnsafe('CREATE TABLE dev_seed_ledger (key text PRIMARY KEY, ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
  await db.$executeRawUnsafe('INSERT INTO dev_seed_marker (marker) VALUES ($1)', marker);
  console.log('Marked this Core database as a dev-seed target: ' + marker);
  return { marker };
}

// ---- seeding ----------------------------------------------------------------------------------------------------
async function seed(db, marker, apiUrl) {
  const credentialsFile = resolve(root, 'test-results/dev-seed', marker.slice(MARKER_PREFIX.length) + '.json');
  const stored = existsSync(credentialsFile) ? JSON.parse(readFileSync(credentialsFile, 'utf8')) : undefined;
  const password = process.env.DEV_SEED_PASSWORD ?? stored?.password ?? randomBytes(12).toString('hex') + 'Aa1!';
  const done = new Map((await db.$queryRawUnsafe('SELECT key, ref FROM dev_seed_ledger')).map(r => [r.key, JSON.parse(r.ref)]));
  const step = async (key, action) => {
    if (done.has(key)) return done.get(key);
    const ref = await action();
    await db.$executeRawUnsafe('INSERT INTO dev_seed_ledger (key, ref) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', key, JSON.stringify(ref));
    done.set(key, ref);
    return ref;
  };
  // A fixed idempotency key per step, so a request whose answer was lost replays instead of duplicating.
  const requestKey = key => { const h = createHash('sha256').update(marker + '|' + key).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
  async function api(method, path, { token, body, key } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(apiUrl + '/api' + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': requestKey(key) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = undefined; }
      if ((res.status === 503 || res.status === 429) && attempt < 8) { await new Promise(ok => setTimeout(ok, Math.min(5000, 1000 * (Number(res.headers.get('retry-after')) || 1)))); continue; }
      return { status: res.status, body: json, text: text.slice(0, 300) };
    }
  }
  const must = (res, what, ok = [200, 201]) => {
    if (!ok.includes(res.status)) fail(`${what}: HTTP ${res.status} ${JSON.stringify(res.body ?? res.text)}`);
    return res.body;
  };

  // accounts: straight into the Core database; a login through the API proves the stack serves this database
  const { hashPasswordAsync } = await import(pathToFileURL(resolve(root, 'backend/dist/src/lib/password.js')).href).catch(() => fail('backend/dist is missing; run `npm run build` first.'));
  const people = {};
  for (const account of ACCOUNTS) {
    const where = account.username ? { username: account.username } : { email: account.email };
    let user = await db.user.findFirst({ where });
    if (!user) user = await db.user.create({ data: { role: account.role, fullName: account.fullName, phone: account.phone, ...where, ...(await hashPasswordAsync(password)) } });
    const login = await api('POST', account.username ? '/auth/admin/login' : '/auth/owner/login', { body: account.username ? { username: account.username, password } : { email: account.email, password } });
    if (login.status === 401) fail(`${account.username ?? account.email} exists but the password does not match; set DEV_SEED_PASSWORD to the one used when it was seeded.`);
    people[account.key] = { id: user.id, token: must(login, 'login ' + account.key).token };
  }
  const admin = people.admin.token, doctor = people.doctor.token;

  const pets = {};
  for (const spec of PETS) {
    const { key, owner, ...fields } = spec;
    pets[key] = await step('pet:' + key, async () => ({ id: must(await api('POST', '/pets', { token: people[owner].token, body: fields }), 'pet ' + key).pet.id }));
  }

  const ownerOf = petKey => people[PETS.find(p => p.key === petKey).owner];
  const staffNote = 'Dữ liệu mẫu dev-seed';
  async function runAppointment(spec) {
    let ref = await step(`appt:${spec.key}:create`, async () => {
      const body = must(await api('POST', '/appointments', { token: ownerOf(spec.pet).token, key: `appt:${spec.key}`, body: { petId: pets[spec.pet].id, type: spec.type, serviceName: spec.service, date: dayOffset(spec.day), time: spec.time, ...(spec.ownerNote ? { ownerNote: spec.ownerNote } : {}) } }), 'appointment ' + spec.key).appointment;
      return { id: body.id, rev: body.statusRevision };
    });
    for (const name of spec.steps) {
      ref = await step(`appt:${spec.key}:${name}`, async () => {
        const where = '/appointments/' + ref.id, label = `appointment ${spec.key} ${name}`, owner = ownerOf(spec.pet).token;
        if (name === 'cancel') { const a = must(await api('PATCH', where + '/cancel', { token: owner, body: { expectedRevision: ref.rev, ownerNote: 'Bận việc đột xuất, xin hủy lịch.' } }), label).appointment; return { ...ref, rev: a.statusRevision }; }
        if (name === 'reschedule') { const a = must(await api('PATCH', where + '/reschedule', { token: owner, body: { date: dayOffset(spec.day + 2), time: spec.time, expectedRevision: ref.rev, ownerNote: 'Xin dời sang hai ngày sau.' } }), label).appointment; return { ...ref, rev: a.statusRevision }; }
        if (name === 'record') {
          // The doctor signs, and saving the visit's record completes an appointment that is checked in or in progress.
          const record = must(await api('POST', '/medical-records', { token: doctor, key: `record:${spec.key}`, body: { petId: pets[spec.pet].id, appointmentId: ref.id, title: 'Lấy cao răng định kỳ', visitDate: dayOffset(spec.day), diagnosis: 'Cao răng độ 2, viêm lợi nhẹ', treatment: 'Cạo vôi răng siêu âm, vệ sinh khoang miệng', symptoms: 'Hơi thở hôi, ăn chậm', medications: 'Dung dịch súc miệng chuyên dụng 5 ngày', weightKg: 3.1, temperatureC: 38.6, followUpDate: dayOffset(spec.day + 30), internalNote: staffNote }, }), label).record;
          return { ...ref, recordId: record.id, rev: ref.rev + 1 };
        }
        if (name === 'invoice') {
          const invoice = must(await api('POST', '/invoices', { token: admin, key: `invoice:${spec.key}`, body: { type: 'appointment', relatedId: ref.id, items: [{ description: 'Cạo vôi răng', quantity: 1, unitPrice: 450000 }, { description: 'Thuốc súc miệng', quantity: 1, unitPrice: 85000 }], notes: staffNote } }), label).invoice;
          return { ...ref, invoiceId: invoice.id };
        }
        if (name === 'checkout') { const invoice = must(await api('POST', '/invoices/checkout', { token: owner, key: `checkout:${spec.key}`, body: { type: 'appointment', relatedId: ref.id } }), label).invoice; return { ...ref, invoiceId: invoice.id }; }
        if (name === 'onsite') { must(await api('PATCH', `/invoices/${ref.invoiceId}/onsite`, { token: owner }), label); return ref; }
        if (name === 'pay') { must(await api('PATCH', `/invoices/${ref.invoiceId}/pay`, { token: admin, body: { paymentMethod: 'cash' } }), label); return ref; }
        const a = must(await api('PATCH', where + '/status', { token: admin, body: { status: name, expectedRevision: ref.rev, internalNote: staffNote } }), label).appointment;
        return { ...ref, rev: a.statusRevision };
      });
    }
  }
  for (const spec of APPOINTMENTS) await runAppointment(spec);

  async function runHotel(spec) {
    let ref = await step(`hotel:${spec.key}:create`, async () => {
      const booking = must(await api('POST', '/hotel-bookings', { token: ownerOf(spec.pet).token, key: `hotel:${spec.key}`, body: { petId: pets[spec.pet].id, checkIn: dayOffset(spec.from), checkOut: dayOffset(spec.to), roomType: spec.room, serviceKeys: spec.services, ...(spec.ownerNote ? { ownerNote: spec.ownerNote } : {}) } }), 'hotel booking ' + spec.key).booking;
      return { id: booking.id, rev: booking.statusRevision };
    });
    for (const name of spec.steps) {
      ref = await step(`hotel:${spec.key}:${name}`, async () => {
        const where = '/hotel-bookings/' + ref.id, label = `hotel booking ${spec.key} ${name}`;
        if (name === 'cancel') { const b = must(await api('PATCH', where + '/cancel', { token: ownerOf(spec.pet).token, body: { expectedRevision: ref.rev, ownerNote: 'Kế hoạch đi chơi thay đổi.' } }), label).booking; return { ...ref, rev: b.statusRevision }; }
        if (name === 'note') { must(await api('POST', where + '/care-notes', { token: admin, body: { note: 'Bé ăn hết khẩu phần, chơi vui, ngủ ngon.', eatingStatus: 'Ăn tốt', mood: 'Vui vẻ', visibleToOwner: true } }), label); return ref; }
        if (name === 'invoice') { const invoice = must(await api('POST', '/invoices', { token: admin, key: `invoice:hotel:${spec.key}`, body: { type: 'hotel_booking', relatedId: ref.id, items: [{ description: 'Phụ thu tắm khô', quantity: 1, unitPrice: 60000 }], notes: staffNote } }), label).invoice; return { ...ref, invoiceId: invoice.id }; }
        if (name === 'pay') { must(await api('PATCH', `/invoices/${ref.invoiceId}/pay`, { token: admin, body: { paymentMethod: 'cash' } }), label); return ref; }
        const b = must(await api('PATCH', where + '/status', { token: admin, body: { status: name, expectedRevision: ref.rev, internalNote: staffNote } }), label).booking;
        return { ...ref, rev: b.statusRevision };
      });
    }
  }
  for (const spec of HOTEL) await runHotel(spec);

  // What the stack now holds, read back through the API (the totals a second run must leave unchanged).
  const total = async path => must(await api('GET', path + (path.includes('?') ? '&' : '?') + 'pageSize=1', { token: admin }), 'read ' + path).pagination.total;
  let notifications = await total('/notifications');
  for (let i = 0; i < 20 && !notifications; i++) { await new Promise(ok => setTimeout(ok, 1000)); notifications = await total('/notifications'); }
  const summary = { marker, pets: await total('/pets'), appointments: await total('/appointments'), hotelBookings: await total('/hotel-bookings'), invoices: await total('/invoices'), medicalRecords: await total('/medical-records'), accounts: ACCOUNTS.length, ledgerSteps: done.size, notifications: notifications > 0 ? 'present' : 'none yet' };
  mkdirSync(resolve(root, 'test-results/dev-seed'), { recursive: true });
  writeFileSync(credentialsFile, JSON.stringify({ marker, apiUrl, password, accounts: ACCOUNTS.map(a => ({ role: a.role, login: a.username ?? a.email })) }, null, 2), { mode: 0o600 });
  console.log(`Seeded. Sign in at ${apiUrl} with password ${password}\n  admin ${ACCOUNTS[0].username}, doctor ${ACCOUNTS[1].username}, owners ${ACCOUNTS.filter(a => a.role === 'owner').map(a => a.email).join(', ')}\n  (also in ${credentialsFile})`);
  console.log('SEED_SUMMARY ' + JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
