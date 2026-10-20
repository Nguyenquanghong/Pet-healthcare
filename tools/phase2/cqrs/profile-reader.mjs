// Q0 diagnostic: the pinned original reader, existing marked 100k trial only.
// No migrations, fixtures, HTTP authorization or projection implementation.
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {assertTestProject} from '../test-project.mjs';
import {profileArgs, distribution, cpuDelta} from './profile-stats.mjs';

if (process.argv.slice(2).join(' ') === '--help') {
  console.log('Usage: node tools/phase2/cqrs/profile-reader.mjs --run --fixture <successful-100k-parity-UUID>\n' +
    'Requires existing pet-phase2-p1-test containers and marked Clinic schema. Read-only SQL.\n' +
    '30s warmup + 120s measured, 20 arrivals/s, maximum 4 in flight, Prisma pool 4.\n' +
    'Records drops/errors, transaction admission, sampled locks, Node/PostgreSQL CPU.\n' +
    'SQL profiling only; not the full HTTP query-heavy protocol or capacity acceptance.');
  process.exit(0);
}
const config = profileArgs(process.argv.slice(2));
const baselineSha = '3e88d7e57fbf4f74da363d320f286244237a4389';
const run = randomUUID(), schema = 'cqrs_q01_' + config.fixture.replaceAll('-', '');
const output = resolve('test-results/phase2/cqrs', 'profile-' + run);
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {run, baselineSha, schema, config, status: 'STARTING', capacityAccepted: false,
  benchmarkStatus: 'DIAGNOSTIC_ONLY', databaseWrites: false, hashes: {},
  limits: ['Direct reader O, synthetic in-memory directory, no HTTP/JWT/Core latency or authorization measurement',
    'Transaction admission includes Prisma scheduling, connection acquisition, BEGIN/isolation and transport; not pure pool wait',
    'Calendar is wrapped in a read-only transaction for profiling; extra instrumentation affects latency',
    'Locks sampled every 500ms; zero observations cannot exclude shorter waits',
    'PostgreSQL cgroup CPU includes observer and any other activity in the dedicated trial container',
    'One 120s run, fixed cyclic workload, warm cache; not 3x300s/1000 samples per operation or O/A/B acceptance']};
mkdirSync(output, {recursive: true});
let db, observer, stage = 'guard';
const requests = [], observations = [];
const command = promisify(execFile);
try {
  assertTestProject();
  const fixtureBytes = readFileSync(resolve('test-results/phase2/cqrs', config.fixture, 'report.json'));
  const fixture = JSON.parse(fixtureBytes);
  assert.equal(fixture.status, 'PASS');
  assert.equal(fixture.baselineSha, baselineSha);
  assert.equal(fixture.run, config.fixture);
  assert.equal(fixture.schema, schema);
  assert.equal(fixture.marker, 'cqrs-q01:' + config.fixture);
  assert.equal(fixture.rows, 100000);
  assert.equal(fixture.parityCases, 200);
  report.hashes.fixtureReport = hash(fixtureBytes);
  for (const file of ['phase2-plan/cqrs/acceptance.json', 'package-lock.json', 'services/clinic/prisma/schema.prisma']) {
    report.hashes[file] = hash(readFileSync(file));
    assert.equal(report.hashes[file], fixture.hashes[file], 'Fixture source/policy drift: ' + file);
  }
  for (const file of ['tools/phase2/cqrs/profile-reader.mjs', 'tools/phase2/cqrs/profile-stats.mjs']) report.hashes[file] = hash(readFileSync(file));
  const url = new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', String(config.poolSize));
  db = new PrismaClient({datasourceUrl: url.href});
  url.searchParams.set('connection_limit', '1');
  observer = new PrismaClient({datasourceUrl: url.href});
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
  assert.deepEqual(identity, {db: 'p2_clinic_test', role: 'p2_clinic'});
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`, [{marker: 'pet-phase2-p1-test:clinic:v1'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${schema}`,
    [{marker: fixture.marker}]);
  assert.equal(await db.appointment.count(), 100000);
  report.database = identity;
  report.postgres = (await db.$queryRaw`SELECT version() AS version`)[0].version;
  report.node = process.version;
  stage = 'original-reader';
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'services/clinic/tsconfig.json'], {stdio: 'pipe'});
  const original = execFileSync('git', ['show', baselineSha + ':services/clinic/src/lists.ts'], {encoding: 'utf8'});
  assert.equal(hash(original), fixture.hashes.baselineReader);
  report.hashes.baselineReader = hash(original);
  for (const file of ['domain/error.ts', 'domain/validation.ts', 'lib/serialize.ts']) {
    const path = 'services/clinic/src/' + file;
    const normalized = value => value.toString().replaceAll('\r\n', '\n');
    assert.equal(hash(normalized(readFileSync(path))), hash(normalized(execFileSync('git', ['show', baselineSha + ':' + path]))), 'Baseline dependency drift');
  }
  writeFileSync(resolve(output, 'baseline-reader.mjs'), stripTypeScriptTypes(original)
    .replace(/from ['"]\.\/([^'"]+)['"]/g, (_, path) => 'from ' + JSON.stringify(pathToFileURL(resolve('services/clinic/dist', path)).href)));
  const old = await import(pathToFileURL(resolve(output, 'baseline-reader.mjs')).href);
  const projected = await db.directoryProjection.findMany({orderBy: [{kind: 'asc'}, {id: 'asc'}]});
  const owners = projected.filter(p => p.kind === 'owner').map(p => ({id: p.id, fullName: p.displayName, directoryVersion: p.sourceVersion}));
  const pets = projected.filter(p => p.kind === 'pet').map(p => ({id: p.id, ownerId: p.ownerId, name: p.displayName, species: 'cat', directoryVersion: p.sourceVersion}));
  assert.equal(owners.length, 100); assert.equal(pets.length, 100);
  const directory = {lookup: async (petIds, ownerIds) => ({pets: pets.filter(p => petIds.includes(p.id)), owners: owners.filter(o => ownerIds.includes(o.id))}),
    pet: async id => pets.find(p => p.id === id)};
  const owner = {sub: owners[0].id, role: 'owner'}, admin = {sub: run, role: 'admin'};
  const local = new AsyncLocalStorage(), application = 'cqrs-profile-' + run;
  const readOnly = work => {
    const called = performance.now();
    return db.$transaction(async tx => {
      const entry = performance.now(), sample = local.getStore();
      if (sample) sample.admissionMs = entry - called;
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$queryRaw`SELECT set_config('application_name', ${application}, true)`;
      const result = await work(tx);
      if (sample) sample.transactionWorkMs = performance.now() - entry;
      return result;
    }, {isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000});
  };
  const readerDb = {$transaction: (work, options) => {
    assert.equal(options?.isolationLevel, 'RepeatableRead'); return readOnly(work);
  }, appointment: {groupBy: query => readOnly(tx => tx.appointment.groupBy(query))}};
  assert.deepEqual(await readOnly(tx => tx.$queryRaw`SELECT current_setting('transaction_read_only') AS mode`), [{mode: 'on'}]);
  const operations = [
    ['owner-list', () => old.list(readerDb, 'appointments', owner, directory, {})],
    ['admin-list', () => old.list(readerDb, 'appointments', admin, directory, {pageSize: '100'})],
    ['admin-search', () => old.list(readerDb, 'appointments', admin, directory, {q: 'Mèo', pageSize: '100'})],
    ['admin-unbilled', () => old.list(readerDb, 'appointments', admin, directory, {mode: 'unbilled'})],
    ['owner-calendar', () => old.calendar(readerDb, owner, '2028-02', undefined)],
    ['admin-calendar', () => old.calendar(readerDb, admin, '2028-02', undefined)],
    ['admin-filter', () => old.list(readerDb, 'appointments', admin, directory, {category: 'spa', statusGroup: 'pending', date: '2028-02-01'})],
    ['admin-page', () => old.list(readerDb, 'appointments', admin, directory, {page: '500', pageSize: '100'})],
  ];
  report.operations = operations.map(([name]) => name);
  const pgContainer = execFileSync('docker', ['compose', '-f', 'deploy/phase2/compose.test.yml', 'ps', '-q', 'postgres'], {encoding: 'utf8'}).trim();
  const pgCpu = async () => {
    const {stdout} = await command('docker', ['exec', pgContainer, 'cat', '/sys/fs/cgroup/cpu.stat'], {timeout: 10000});
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => line.trim().split(/\s+/)));
    assert.ok(/^\d+$/.test(fields.usage_usec), 'cgroup v2 CPU counter unavailable');
    return {usageUsec: Number(fields.usage_usec), throttledUsec: Number(fields.throttled_usec ?? 0), sampledAt: Date.now()};
  };
  async function phase(name, seconds) {
    const active = new Set(), start = performance.now(), epoch = Date.now();
    let maxActive = 0, stop = false;
    const monitoring = (async () => {
      while (!stop) {
        const [row] = await observer.$queryRaw`SELECT count(*)::int AS sessions,
          count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiters,
          count(*) FILTER (WHERE state='active')::int AS active,
          (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE a.application_name=${application} AND NOT l.granted) AS ungranted_locks
          FROM pg_stat_activity WHERE application_name=${application}`;
        observations.push({phase: name, atMs: performance.now() - start, ...row});
        await sleep(500);
      }
    })();
    // Attach a handler immediately so an observer error cannot become unhandled.
    let observationError;
    const observed = monitoring.catch(error => { observationError = error; });
    try {
      for (let i = 0; i < seconds * config.arrivalRate; i++) {
        const due = i * 1000 / config.arrivalRate;
        await sleep(Math.max(0, due - (performance.now() - start)));
        const [operation, invoke] = operations[i % operations.length];
        const sample = {phase: name, sequence: i, operation, scheduledAt: epoch + due, schedulerLagMs: Math.max(0, performance.now() - start - due)};
        requests.push(sample);
        if (active.size >= config.concurrency || performance.now() - start >= seconds * 1000) {
          sample.status = 'DROPPED'; continue;
        }
        const task = local.run(sample, async () => {
          const began = performance.now();
          try { await invoke(); sample.status = 'OK'; }
          catch (error) { sample.status = 'ERROR'; sample.error = error.code ?? error.name; }
          finally { sample.elapsedMs = performance.now() - began; }
        });
        active.add(task); maxActive = Math.max(maxActive, active.size);
        task.finally(() => active.delete(task));
      }
      await sleep(Math.max(0, seconds * 1000 - (performance.now() - start)));
      await Promise.all(active);
    } finally { stop = true; await observed; }
    if (observationError) throw observationError;
    return {name, startEpochMs: epoch, durationIncludingDrainAndObserverMs: performance.now() - start, maxActive};
  }
  stage = 'warmup';
  console.log(JSON.stringify({run, stage, seconds: config.warmupSeconds}));
  report.warmup = await phase('warmup', config.warmupSeconds);
  assert.ok(requests.every(r => r.status === 'OK'), 'Warmup errors/drops; stop without retries');
  stage = 'measured';
  const beforePg = await pgCpu(), beforeNode = process.cpuUsage(), cpuStart = performance.now();
  console.log(JSON.stringify({run, stage, seconds: config.measuredSeconds}));
  report.measured = await phase('measured', config.measuredSeconds);
  const nodeCpu = process.cpuUsage(beforeNode), nodeIntervalMs = performance.now() - cpuStart, afterPg = await pgCpu();
  const measured = requests.filter(r => r.phase === 'measured'), successes = measured.filter(r => r.status === 'OK');
  report.counts = {scheduled: measured.length, successes: successes.length, errors: measured.filter(r => r.status === 'ERROR').length, drops: measured.filter(r => r.status === 'DROPPED').length};
  report.cpu = {node: cpuDelta(0, nodeCpu.user + nodeCpu.system, nodeIntervalMs, successes.length),
    postgres: cpuDelta(beforePg.usageUsec, afterPg.usageUsec, afterPg.sampledAt - beforePg.sampledAt, successes.length),
    raw: {beforePg, afterPg, nodeCpu},
    nodeIntervalMs, postgresIntervalMs: afterPg.sampledAt - beforePg.sampledAt, postgresThrottledUsec: afterPg.throttledUsec - beforePg.throttledUsec};
  report.measurements = operations.map(([operation]) => {
    const samples = successes.filter(r => r.operation === operation);
    return {operation, elapsedMs: distribution(samples.map(r => r.elapsedMs)), admissionMs: distribution(samples.map(r => r.admissionMs)),
      transactionWorkMs: distribution(samples.map(r => r.transactionWorkMs))};
  });
  const observed = observations.filter(r => r.phase === 'measured');
  assert.ok(observed.length > 0, 'Missing observer samples');
  report.locks = {samples: observed.length, samplesWithLockWait: observed.filter(r => r.lock_waiters > 0).length,
    maxWaiters: Math.max(...observed.map(r => r.lock_waiters)), maxUngranted: Math.max(...observed.map(r => r.ungranted_locks))};
  report.schedulerLagMs = distribution(measured.map(r => r.schedulerLagMs));
  assert.equal(await db.appointment.count(), 100000);
  report.status = report.counts.errors || report.counts.drops ? 'LOAD_NOT_SUSTAINED' : 'PROFILE_RECORDED';
  if (report.status !== 'PROFILE_RECORDED') process.exitCode = 1;
  console.log(JSON.stringify({run, status: report.status, counts: report.counts, artifact: output}));
} catch (error) {
  report.status = 'FAIL'; report.failedStage = stage;
  report.error = error instanceof assert.AssertionError ? error.message : error.code ?? error.name;
  console.error(JSON.stringify({run, status: report.status, stage, error: report.error}));
  process.exitCode = 1;
} finally {
  await Promise.all([db?.$disconnect(), observer?.$disconnect()]);
  writeFileSync(resolve(output, 'samples.json'), JSON.stringify({requests, observations}, null, 2));
  report.hashes.samples = hash(readFileSync(resolve(output, 'samples.json')));
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
