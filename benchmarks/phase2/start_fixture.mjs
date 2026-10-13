// Reuse the guarded real-service E2E environment, with UUID data only.
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { assertTestProject } from '../../tools/phase2/test-project.mjs';

const run = process.env.PHASE2_LOAD_RUN;
if (!/^[0-9a-f-]{36}$/.test(run ?? '')) throw new Error('LOAD_RUN_ID_REQUIRED');
assertTestProject();
const probe = createServer().listen(5189, '127.0.0.1');
await once(probe, 'listening');
await new Promise(resolve => probe.close(resolve));
const directory = resolve('test-results/phase2');
mkdirSync(directory, { recursive: true });
const lock = resolve(directory, 'load-fixture.lock');
writeFileSync(lock, JSON.stringify({ pid: process.pid, run }), { flag: 'wx' });
const manifestPath = resolve(directory, `load-${run}.json`);
let shutdown, manifest;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (shutdown) await shutdown();
    if (manifest) writeFileSync(manifestPath, JSON.stringify({ ...manifest, stoppedAt: new Date().toISOString() }, null, 2));
  } catch {
    process.exitCode = 1;
    if (manifest) writeFileSync(manifestPath, JSON.stringify({ ...manifest, stoppedAt: new Date().toISOString(), shutdownFailed: true }, null, 2));
    process.stderr.write('LOAD_FIXTURE_SHUTDOWN_FAILED; inspect local log\n');
  } finally {
    if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).run === run) unlinkSync(lock);
    process.stdin.pause();
  }
}
try {
  process.env.PHASE2_TEST_CONFIRM = 'pet-phase2-p1-test';
  ({ shutdown } = await import('../../tools/phase2/e2e-server.mjs'));
  const fixture = JSON.parse(readFileSync(resolve(directory, 'p5-e2e-fixture.json'), 'utf8'));
  const fixtureFile = resolve(directory, `load-${run}-fixture.json`);
  // Ignored local file only; notebook outputs/reports never include these values.
  writeFileSync(fixtureFile, JSON.stringify({ ...fixture, metricsToken: process.env.OBSERVABILITY_TOKEN }), { flag: 'wx' });
  manifest = {
    version: 1, kind: 'phase2-local-load-fixture', run, fixtureRun: fixture.run,
    pid: process.pid, baseUrl: 'http://127.0.0.1:5189', fixtureFile,
    startedAt: new Date().toISOString(), composeProject: 'pet-phase2-p1-test',
    topology: 'B1-like: one API per service, Node test proxy, shared PostgreSQL instance; not production Nginx',
    clinicReplicas: 1, clientAndServerSameHost: true,
    dataset: fixture.dataset ?? {version:'single-owner-v1',accounts:1,pets:21},
    limits: { readPerActorPerMinute: 600, writePerActorPerMinute: 120, loginPerAccountPer15Minutes: 30 },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  process.stdout.write('LOAD_FIXTURE_READY\n');
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; if (input.includes('stop')) void stop(); });
  process.stdin.once('end', () => void stop());
  process.stdin.resume();
} catch (error) {
  await stop();
  throw error;
}
