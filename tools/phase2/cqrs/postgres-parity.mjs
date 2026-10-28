// Q0/Q1 only: real SQL characterization against the pinned pre-CQRS reader.
// Creates a new marked schema inside the dedicated Clinic trial DB; retains it.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, posix, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {stripTypeScriptTypes} from 'node:module';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {assertTestProject} from '../test-project.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node tools/phase2/cqrs/postgres-parity.mjs --run [--large]\n' +
    'Requires the guarded pet-phase2-p1-test project. Compiles Clinic, verifies DB/role/marker,\n' +
    'creates a fresh UUID schema and applies existing migrations there. 420 rows (100,000\n' +
    'with --large), PostgreSQL parity + SQL diagnostics. Keeps trial schema/artifacts.\n' +
    'No HTTP load/PCN acceptance, projection, new database, or production credentials.');
  process.exit(0);
}
assert.ok(args.includes('--run') && args.length <= 2 && args.every(a => ['--run', '--large'].includes(a)) && new Set(args).size === args.length, 'Use --help');
const baselineSha = '3e88d7e57fbf4f74da363d320f286244237a4389';
const run = randomUUID(), schema = 'cqrs_q01_' + run.replaceAll('-', '');
const marker = 'cqrs-q01:' + run;
const output = resolve('test-results/phase2/cqrs', run);
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2));
const report = {run, baselineSha, schema, marker, status: 'STARTING', parityCases: 0,
  benchmarkStatus: 'INSUFFICIENT_SAMPLES', capacityAccepted: false,
  rows: args.includes('--large') ? 100000 : 420, queryWritesAllowed: false,
  limits: ['SQL diagnostic only; no HTTP/JWT/Core latency, CPU budget or PCN acceptance',
    'Directory DTO provider is synthetic; Core authorization is covered by the separate Clinic HTTP suite',
    'Single sequential client, warm cache, 20 samples/operation; not the Q6 query-heavy protocol'],
  hashes: {}, measurements: [], plans: []};
mkdirSync(output, {recursive: true});
assertTestProject();
// No ambient DATABASE_URL or .env is used. Only this loopback trial is allowed.
const url = new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');
url.searchParams.set('schema', schema);
url.searchParams.set('connection_limit', '1');
const queries = [];
const db = new PrismaClient({datasourceUrl: url.href, log: [{emit: 'event', level: 'query'}]});
db.$on('query', event => queries.push(event));
let stage = 'identity';
try {
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
  assert.deepEqual(identity, {db: 'p2_clinic_test', role: 'p2_clinic'});
  const markers = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.deepEqual(markers, [{marker: 'pet-phase2-p1-test:clinic:v1'}]);
  assert.match(schema, /^cqrs_q01_[0-9a-f]{32}$/);
  assert.match(marker, /^cqrs-q01:[0-9a-f-]{36}$/);
  const exists = await db.$queryRaw`SELECT oid FROM pg_namespace WHERE nspname=${schema}`;
  assert.equal(exists.length, 0, 'Never reuse an existing schema');
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  await db.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
  const [scope] = await db.$queryRaw`SELECT nspname, obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${schema}`;
  assert.deepEqual(scope, {nspname: schema, marker});
  stage = 'existing-migrations';
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'services/clinic/prisma/schema.prisma'],
    {env: {...process.env, DATABASE_URL: url.href}, stdio: 'pipe'});
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'services/clinic/tsconfig.json'], {stdio: 'pipe'});
  execFileSync(process.execPath, ['../../tools/phase2/copy-client.mjs'], {cwd: 'services/clinic', stdio: 'pipe'});
  const {AuthoritativeAppointmentQueries} = await import('../../../services/clinic/dist/infrastructure/queries/authoritativeAppointments.js');
  // The pinned reader runs with its own pinned helpers (error, validation, serialize), so
  // parity compares the pre-CQRS reader with today's reader, not today's helpers twice;
  // every other relative import (generated client) resolves to the current build.
  const pinned = ['lists', 'domain/error', 'domain/validation', 'lib/serialize'];
  const baselineRoot = resolve(output, 'baseline');
  const source = Object.fromEntries(pinned.map(name => [name, execFileSync('git', ['show', baselineSha + ':services/clinic/src/' + name + '.ts'], {encoding: 'utf8'})]));
  for (const name of pinned) {
    const code = stripTypeScriptTypes(source[name], {mode: 'transform'}).replace(/from ['"](\.{1,2}\/[^'"]+)['"]/g, (_, spec) => {
      const target = posix.normalize(posix.join(posix.dirname(name), spec)).replace(/\.js$/, '');
      return 'from ' + JSON.stringify(pathToFileURL(pinned.includes(target) ? resolve(baselineRoot, target + '.mjs') : resolve('services/clinic/dist', target + '.js')).href);
    });
    mkdirSync(dirname(resolve(baselineRoot, name + '.mjs')), {recursive: true});
    writeFileSync(resolve(baselineRoot, name + '.mjs'), code);
  }
  const original = source.lists;
  const old = await import(pathToFileURL(resolve(baselineRoot, 'lists.mjs')).href);
  for (const file of ['tools/phase2/cqrs/postgres-parity.mjs', 'services/clinic/src/infrastructure/queries/authoritativeLists.ts',
    'services/clinic/src/infrastructure/queries/authoritativeAppointments.ts', 'services/clinic/prisma/schema.prisma', 'phase2-plan/cqrs/acceptance.json', 'package-lock.json']) report.hashes[file] = hash(readFileSync(file));
  report.hashes.baselineReader = hash(original);
  report.hashes.baselineHelpers = Object.fromEntries(pinned.filter(name => name !== 'lists').map(name => [name, hash(source[name])]));
  report.node = process.version;
  report.database = identity;
  report.postgres = (await db.$queryRaw`SELECT version() AS version`)[0].version;
  stage = 'fixture';
  const owners = Array.from({length: 100}, (_, i) => ({id: randomUUID(), fullName: 'Nguyễn thử ' + i, directoryVersion: 3}));
  const pets = owners.map((o, i) => ({id: randomUUID(), ownerId: o.id, name: 'Mèo thử ' + i, species: 'cat', directoryVersion: 3}));
  const statuses = ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'];
  const types = ['general_checkup', 'vaccination', 'dental', 'dermatology', 'surgery', 'hotel_consultation', 'spa_bath', 'spa_grooming', 'spa_combo', 'other'];
  const rows = Array.from({length: report.rows}, (_, i) => {
    const pet = pets[i % pets.length], slot = Math.floor(i / pets.length);
    return {id: randomUUID(), petId: pet.id, ownerId: pet.ownerId, type: types[i % types.length],
      serviceName: 'Khám có dấu ' + (i % 13), clinicName: 'Synthetic Clinic', status: statuses[i % statuses.length],
      appointmentDate: new Date(Date.UTC(2028, 1, 1 + Math.floor(slot / 48))), appointmentTime: String(Math.floor(slot % 48 / 2)).padStart(2, '0') + (slot % 2 ? ':30' : ':00'),
      ownerNote: 'Synthetic owner note', internalNote: 'Q01_PRIVATE', statusRevision: i % 4,
      createdAt: new Date(Date.UTC(2027, 0, 1) + i * 1000), updatedAt: new Date(Date.UTC(2027, 0, 1) + i * 1000)};
  });
  const reservations = rows.filter((_, i) => i % 17 === 0).map((r, i) => ({operationId: randomUUID(), appointmentId: r.id,
    revisionAtPrepare: r.statusRevision, snapshot: {}, state: ['HELD', 'INVOICED', 'RELEASED'][i % 3]}));
  await db.directoryProjection.createMany({data: [...owners.map(o => ({kind: 'owner', id: o.id, displayName: o.fullName, sourceVersion: 3})),
    ...pets.map(p => ({kind: 'pet', id: p.id, ownerId: p.ownerId, displayName: p.name, sourceVersion: 3}))]});
  for (let i = 0; i < rows.length; i += 1000) await db.appointment.createMany({data: rows.slice(i, i + 1000)});
  for (let i = 0; i < reservations.length; i += 1000) await db.appointmentReservation.createMany({data: reservations.slice(i, i + 1000)});
  await db.medicalRecord.createMany({data: rows.slice(0, 100).map(r => ({id: randomUUID(), appointmentId: r.id, petId: r.petId, ownerId: r.ownerId,
    doctorName: 'Synthetic doctor', visitDate: r.appointmentDate, title: 'Khám thử', diagnosis: 'Synthetic', treatment: 'Synthetic', internalNote: 'Q01_PRIVATE', weightKg: 4.25}))});
  await db.medicalImage.createMany({data: pets.map(p => ({id: randomUUID(), ownerId: p.ownerId, petId: p.id, title: 'Ảnh thử', imageUrl: 'data:image/png;base64,AA==', mimeType: 'image/png'}))});
  await db.$executeRawUnsafe(`ANALYZE "${schema}".appointments`);
  await db.$executeRawUnsafe(`ANALYZE "${schema}"."AppointmentReservation"`);
  report.fixture = {version: 'cqrs-q01-v1', owners: owners.length, pets: pets.length, reservations: reservations.length,
    medicalRecords: 100, medicalImages: 100, hash: hash(JSON.stringify(rows)), synthetic: true};
  // PostgreSQL itself rejects writes in every reader transaction, including calendar.
  const readOnly = work => db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return work(tx);
  }, {isolationLevel: 'RepeatableRead', timeout: 30000});
  const readerDb = {$transaction: (work, options) => {
    assert.equal(options?.isolationLevel, 'RepeatableRead');
    return readOnly(work);
  }, appointment: {groupBy: query => readOnly(tx => tx.appointment.groupBy(query))}};
  const current = new AuthoritativeAppointmentQueries(readerDb);
  const directory = {lookup: async (petIds, ownerIds) => ({pets: pets.filter(p => petIds.includes(p.id)), owners: owners.filter(o => ownerIds.includes(o.id))}),
    pet: async id => pets.find(p => p.id === id)};
  const actors = [{sub: owners[0].id, role: 'owner'}, {sub: owners[1].id, role: 'owner'}, {sub: randomUUID(), role: 'admin'}, {sub: randomUUID(), role: 'staff'}];
  const json = value => JSON.parse(JSON.stringify(value));
  const matrix = [{}, {pageSize: '100'}, {pageSize: '1'}, {page: '1000000'}, {id: rows[0].id}, {id: rows[1].id},
    {ownerId: owners[1].id}, {petId: pets[0].id}, {q: 'Mèo'}, {q: 'Nguyễn'}, {q: 'KHÁM CÓ DẤU'}, {q: 'missing'},
    {date: '2028-02-01'}, {category: 'spa'}, {category: 'medical'}, {mode: 'unbilled'},
    ...statuses.map(status => ({status})), ...['pending', 'completed', 'cancelled'].map(statusGroup => ({statusGroup})),
    {statusGroup: 'pending', status: 'completed'}, {statusGroup: 'pending', status: 'confirmed'},
    {category: 'spa', date: '2028-02-01', status: 'completed'}, {q: 'Khám', petId: pets[0].id, pageSize: '100'},
    {mode: 'unbilled', status: 'completed', pageSize: '100'}];
  stage = 'parity';
  for (const actor of actors) {
    for (const raw of matrix) {
      const expected = json(await old.list(readerDb, 'appointments', actor, directory, raw));
      const actual = json(await current.list(actor, directory, raw));
      assert.deepEqual(actual, expected, 'Appointment parity ' + JSON.stringify({role: actor.role, raw}));
      if (actor.role === 'owner') {
        assert.ok(actual.items.every(r => r.ownerId === actor.sub && !('internalNote' in r)));
        assert.ok(actual.related.owners.every(o => o.id === actor.sub));
        assert.ok(actual.related.pets.every(p => p.ownerId === actor.sub));
      }
      report.parityCases++;
    }
    const first = await current.list(actor, directory, {pageSize: '100'});
    for (const page of [String(first.pagination.totalPages || 1), String(first.pagination.totalPages + 1)]) {
      assert.deepEqual(json(await current.list(actor, directory, {pageSize: '100', page})), json(await old.list(readerDb, 'appointments', actor, directory, {pageSize: '100', page})));
      report.parityCases++;
    }
    for (const month of ['2028-02', '2028-03', '2028-12']) for (const category of [undefined, 'medical', 'spa']) {
      assert.deepEqual(await current.calendar(actor, {month, category}), await old.calendar(readerDb, actor, month, category));
      report.parityCases++;
    }
    const {list} = await import('../../../services/clinic/dist/infrastructure/queries/authoritativeLists.js');
    // AQ-09: an image list returns metadata and a valet key, never the content or the
    // storage columns. The pinned reader returns whole rows (now with the claim columns),
    // so the fixture's legacy base64 rows list as that row without content and storage fields.
    const aq09 = (resource, page) => resource !== 'medicalImages' ? page
      : {...page, items: page.items.map(({imageUrl, storageKey, sha256, ...item}) => ({...item, sizeBytes: null, url: null, urlExpiresAt: null}))};
    for (const resource of ['medicalRecords', 'medicalImages']) for (const raw of [{}, {q: 'thử'}, {petId: pets[0].id}, {page: '2', pageSize: '1'}]) {
      assert.deepEqual(json(await list(readerDb, resource, actor, directory, raw)), aq09(resource, json(await old.list(readerDb, resource, actor, directory, raw))));
      report.parityCases++;
    }
  }
  stage = 'sql-diagnostics';
  const operations = [
    ['owner-list', () => old.list(readerDb, 'appointments', actors[0], directory, {})],
    ['admin-list', () => old.list(readerDb, 'appointments', actors[2], directory, {pageSize: '100'})],
    ['admin-search', () => old.list(readerDb, 'appointments', actors[2], directory, {q: 'Mèo', pageSize: '100'})],
    ['admin-unbilled', () => old.list(readerDb, 'appointments', actors[2], directory, {mode: 'unbilled'})],
    ['owner-calendar', () => old.calendar(readerDb, actors[0], '2028-02', undefined)],
    ['admin-calendar', () => old.calendar(readerDb, actors[2], '2028-02', undefined)],
  ];
  for (const [operation, invoke] of operations) {
    queries.length = 0;
    await invoke();
    const selects = queries.filter(q => /^SELECT\b/.test(q.query));
    for (const query of selects) {
      // Prisma query events encode Date parameters as JSON strings. Let PostgreSQL
      // infer the original parameter types via PREPARE, rather than raw-query
      // bindings (which otherwise force text for dates/enums).
      const params = JSON.parse(query.params);
      const literal = value => value === null ? 'NULL' : Array.isArray(value) ? 'ARRAY[' + value.map(literal).join(',') + ']' :
        typeof value === 'number' || typeof value === 'boolean' ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
      const plan = await readOnly(async tx => {
        await tx.$executeRawUnsafe('PREPARE cqrs_explain AS ' + query.query);
        try {
          return await tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE cqrs_explain' + (params.length ? '(' + params.map(literal).join(',') + ')' : ''));
        } finally { await tx.$executeRawUnsafe('DEALLOCATE cqrs_explain'); }
      });
      report.plans.push({operation, queryHash: hash(query.query), plan});
    }
    const elapsed = [], sqlMs = [];
    for (let n = 0; n < 20; n++) {
      queries.length = 0;
      const started = performance.now();
      await invoke();
      elapsed.push(performance.now() - started);
      sqlMs.push(queries.filter(q => /^SELECT\b/.test(q.query)).reduce((sum, q) => sum + q.duration, 0));
    }
    const sorted = [...elapsed].sort((a, b) => a - b);
    report.measurements.push({operation, samples: elapsed.length, selectCount: selects.length,
      p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], elapsedMs: elapsed, sqlMs});
  }
  report.disk = await db.$queryRaw`SELECT SUM(pg_total_relation_size(c.oid))::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND c.relkind='r'`;
  assert.equal(await db.appointment.count(), report.rows);
  report.status = 'PASS';
  console.log(JSON.stringify({run, status: report.status, parityCases: report.parityCases, rows: report.rows, artifact: output}));
} catch (error) {
  report.status = 'FAIL';
  report.failedStage = stage;
  // Child-process/migration errors can contain credentials; do not dump them.
  report.error = error instanceof assert.AssertionError ? error.message : error.code ?? error.name;
  if (error instanceof TypeError || error instanceof SyntaxError) report.detail = error.message.replace(/(?:postgresql|amqp):\/\/\S+/g, '[redacted]');
  console.error(JSON.stringify({run, status: 'FAIL', stage, error: report.error, detail: report.detail}));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
  save('report.json', report);
}
