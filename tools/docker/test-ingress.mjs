// Ingress of the real root Compose + docker-compose.phase2.yml, driven through the frontend port (the nginx in
// frontend/nginx/default.conf.template), on its own project with fresh volumes. Nothing else sends traffic through
// that nginx: test:docker:phase2 calls Core directly. Never reads .env.docker and never touches another project.
//
// Checks (each reports PASS or FAIL and the run goes on, so one run shows everything that is wrong):
//   - the demo seed refuses an unmarked database and production, then seeds the marked one, twice, with no duplicates;
//   - sign-in, lists, and a 5 MiB image (about 7 MB of base64 JSON) go through; a body over 8 MB is refused;
//   - /internal, /metrics and /health answer 404 on the frontend port, never the single-page-app fallback;
//   - the per-IP limiter tells clients apart: three different source addresses (the host, and two other containers on
//     the Compose network) get their own buckets, and a forged X-Forwarded-For neither shares nor dodges a bucket.
// The 'pet-k0-' prefix is what the plan reserves for throwaway projects.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { freeNetworkPrefix } from './network-prefix.mjs';
import { preparePhase2 } from './prepare-phase2.mjs';

if (process.argv.length > 2) throw new Error('Unknown argument');
const project = 'pet-k0-' + randomBytes(4).toString('hex');
assert.match(project, /^pet-k0-[a-f0-9]{8}$/);
const dir = resolve('test-results/k0/' + project), log = resolve(dir, 'docker.log'), results = [];
mkdirSync(dir, { recursive: true });
const envFile = resolve(dir, '.env');
const secret = () => randomBytes(24).toString('hex');
const freePort = async () => { const s = createServer(); await new Promise((ok, fail) => { s.once('error', fail); s.listen(0, '127.0.0.1', ok); }); const p = s.address().port; await new Promise(ok => s.close(ok)); return p; };
const [port, frontendPort, dbPort, blobPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
const prefix = freeNetworkPrefix(), password = secret(), seedPassword = secret() + 'Aa1!';
writeFileSync(envFile, `POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://nipopeto:${password}@postgres:5432/nipopeto?schema=public\nPORT=${port}\nFRONTEND_PORT=${frontendPort}\nCORE_DB_PORT=${dbPort}\nBLOB_PORT=${blobPort}\nBLOB_PUBLIC_ENDPOINT=http://127.0.0.1:${blobPort}\nPET_NET_PREFIX=${prefix}\n`, { flag: 'wx', mode: 0o600 });
preparePhase2(envFile);
const composeArgs = ['compose', '--project-name', project, '--env-file', envFile, '-f', resolve('docker-compose.yml'), '-f', resolve('docker-compose.phase2.yml')];
const baseEnv = { ...process.env, COMPOSE_PARALLEL_LIMIT: '1' };
// Shell values override --env-file; isolate every interpolation input from the host.
for (const key of Object.keys(baseEnv)) if (/^(JWT_|DATABASE_URL$|POSTGRES_PASSWORD$|NOTIFICATION_|CORE_|CLINIC_|RATE_LIMIT_|OBSERVABILITY_|PHASE2_|REDIS_|BROKER_|PORT$|FRONTEND_PORT$|CORS_ORIGIN$|VNPAY_|BANK_TRANSFER_|COMPOSE_|PET_|BLOB_|DEV_SEED_)/.test(key)) delete baseEnv[key];
baseEnv.COMPOSE_PARALLEL_LIMIT = '1';
function run(command, args, { input, env = baseEnv } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.once('error', fail);
    const timer = setTimeout(() => { child.kill(); fail(new Error(command + ' timed out')); }, 1800000);
    child.once('close', code => { clearTimeout(timer); const error = code === 0 ? undefined : new Error(`${command} failed (${code}); see the private log`); if (error) { appendFileSync(log, output); Object.defineProperty(error, 'output', { value: output }); Object.defineProperty(error, 'code', { value: code }); } error ? fail(error) : ok(output); });
    child.stdin.end(input);
  });
}
const docker = (args, input) => run('docker', args, { input });
const compose = (...args) => docker([...composeArgs, ...args]);
const exec = (service, args, input) => docker([...composeArgs, 'exec', '-T', service, ...args], input);

async function check(name, action) {
  try { const detail = await action(); results.push({ name, result: 'PASS', detail }); console.log('PASS ' + name + (detail ? ' (' + detail + ')' : '')); }
  catch (error) { results.push({ name, result: 'FAIL', detail: String(error.message).slice(0, 600) }); console.log('FAIL ' + name + '\n     ' + String(error.message).split('\n').slice(0, 6).join('\n     ')); }
}
const origin = `http://127.0.0.1:${frontendPort}`, coreOrigin = `http://127.0.0.1:${port}`;
async function http(base, path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, type: res.headers.get('content-type') ?? '', json, text: text.slice(0, 200) };
}
// Unauthenticated rescue reports count against the per-IP bucket (20 per 15 minutes) before any route runs.
const rescueUrl = () => '/api/public/pets/k0-' + randomBytes(8).toString('hex') + '/rescue-reports';
const rescue = (base, headers = {}) => http(base, rescueUrl(), { method: 'POST', body: { message: 'x' }, headers });
const rescueFrom = async (service, count, forge) => JSON.parse((await exec(service, ['node', '--input-type=module', '-'], `
  const out = [];
  for (let i = 0; i < ${count}; i++) {
    const headers = { 'content-type': 'application/json' };
    ${forge ? "headers['x-forwarded-for'] = '203.0.113.' + (10 + i);" : ''}
    const res = await fetch('http://frontend:8080/api/public/pets/k0-' + Math.random().toString(16).slice(2) + '/rescue-reports', { method: 'POST', headers, body: '{"message":"x"}' });
    out.push(res.status);
    await res.arrayBuffer();
  }
  console.log(JSON.stringify(out));
`)).trim().split('\n').at(-1));
const seedEnv = extra => ({ ...baseEnv, DEV_SEED_DATABASE_URL: `postgresql://nipopeto:${password}@127.0.0.1:${dbPort}/nipopeto?schema=public`, DEV_SEED_API_URL: origin, DEV_SEED_PASSWORD: seedPassword, ...extra });
const seed = (args = [], extra = {}) => run(process.execPath, ['tools/phase2/dev-seed.mjs', ...args], { env: seedEnv(extra) });
const seedFails = async (args, extra, expected) => { try { await seed(args, extra); } catch (error) { assert.match(error.output, expected); return error.output.trim().split('\n').at(-1); } throw new Error('the seed was expected to refuse but succeeded'); };
const summaryOf = output => JSON.parse(output.match(/^SEED_SUMMARY (.*)$/m)[1]);

let failed = false;
try {
  assert.equal((await docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project])).trim(), '');
  console.log(`Project ${project}, network ${prefix}.0/24; evidence in ${dir}`);
  const config = JSON.parse(await compose('config', '--format', 'json'));
  await check('Compose pins the network and trusts only the frontend address for forwarded client IPs', () => {
    assert.equal(config.services.frontend.networks.default.ipv4_address, prefix + '.10');
    assert.equal(config.services.api.environment.TRUST_PROXY_CIDRS, prefix + '.10/32');
    assert.equal(config.networks.default.ipam.config[0].subnet, prefix + '.0/24');
  });
  appendFileSync(log, await compose('build', 'api', 'migrate', 'notification-api', 'notification-migrate', 'notification-worker', 'core-outbox', 'clinic-api', 'clinic-migrate', 'clinic-worker', 'core-billing', 'frontend'));
  appendFileSync(log, await compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '240', 'api', 'core-outbox', 'notification-worker', 'clinic-worker', 'core-billing', 'frontend'));
  for (const id of (await compose('ps', '-q')).trim().split(/\s+/)) {
    const [container] = JSON.parse(await docker(['inspect', id]));
    assert.equal(container.Config.Labels['com.docker.compose.project'], project);
    for (const mount of container.Mounts) if (mount.Type === 'volume') assert.ok(mount.Name.startsWith(project + '_'));
  }
  const coreUsers = async () => Number((await exec('postgres', ['psql', '-U', 'nipopeto', '-d', 'nipopeto', '-Atc', 'SELECT count(*) FROM users'])).trim());

  await check('Seed refuses production and an unmarked database, and writes nothing', async () => {
    await seedFails([], { NODE_ENV: 'production' }, /NODE_ENV=production/);
    const refusal = await seedFails([], {}, /no dev-seed marker/);
    assert.equal(await coreUsers(), 0);
    return refusal.slice(0, 70);
  });
  await check('Seed marks the fresh database on request and refuses to mark it twice', async () => {
    assert.match(await seed(['--mark']), /Marked this Core database/);
    await seedFails(['--mark'], {}, /already marked/);
  });
  let first;
  await check('Seed fills the stack through the frontend port', async () => {
    first = summaryOf(await seed());
    assert.ok(first.pets >= 8 && first.appointments >= 10 && first.hotelBookings >= 5 && first.invoices >= 3 && first.medicalRecords >= 1, JSON.stringify(first));
    return `${first.pets} pets, ${first.appointments} appointments, ${first.hotelBookings} hotel bookings, ${first.invoices} invoices, ${first.medicalRecords} records`;
  });
  await check('A second seed run duplicates nothing', async () => {
    const second = summaryOf(await seed());
    assert.deepEqual(second, { ...first, notifications: second.notifications });
    assert.equal(await coreUsers(), 5);
  });

  const login = async (path, body) => { const res = await http(origin, path, { method: 'POST', body }); assert.equal(res.status, 200, JSON.stringify(res.json ?? res.text)); return res.json.token; };
  let admin, owner;
  await check('Sign in and read lists through nginx', async () => {
    admin = await login('/api/auth/admin/login', { username: 'dev_admin', password: seedPassword });
    owner = await login('/api/auth/owner/login', { email: 'lananh@example.test', password: seedPassword });
    const pets = await http(origin, '/api/pets?pageSize=50', { token: admin }), mine = await http(origin, '/api/pets?pageSize=50', { token: owner });
    assert.equal(pets.status, 200); assert.equal(pets.json.pagination.total, first.pets);
    assert.deepEqual(mine.json.items.map(p => p.name).sort(), ['Bông', 'Lucky', 'Mochi']);
    assert.equal((await http(origin, '/api/appointments?pageSize=50', { token: admin })).json.pagination.total, first.appointments);
  });

  await check('A 5 MiB image uploads through the frontend port; a body over 8 MB is refused', async () => {
    const pet = (await http(origin, '/api/pets?pageSize=50', { token: admin })).json.items[0];
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(5 * 1024 * 1024 - 8)]);
    const body = JSON.stringify({ petId: pet.id, title: 'Ảnh X-quang thử', imageUrl: 'data:image/png;base64,' + png.toString('base64'), mimeType: 'image/png' });
    const ok = await http(origin, '/api/medical-records/images', { token: admin, method: 'POST', body });
    assert.equal(ok.status, 201, `${Buffer.byteLength(body)} bytes: HTTP ${ok.status} ${ok.text.slice(0, 120)}`);
    const huge = await http(origin, '/api/medical-records/images', { token: admin, method: 'POST', body: JSON.stringify({ petId: pet.id, title: 'x', imageUrl: 'A'.repeat(9 * 1024 * 1024), mimeType: 'image/png' }) });
    assert.equal(huge.status, 413, 'HTTP ' + huge.status);
    return `${Buffer.byteLength(body)} bytes accepted, 9 MiB gets ${huge.status}`;
  });

  await check('/internal, /metrics and /health are 404 on the frontend port, never the SPA fallback', async () => {
    const seen = [];
    for (const [method, path] of [['GET', '/health'], ['GET', '/health/ready'], ['GET', '/metrics'], ['POST', '/internal/notifications/authorize-send'], ['GET', '/internal/directory/owners']]) {
      const res = await http(origin, path, { method, ...(method === 'POST' ? { body: {} } : {}) });
      seen.push(`${method} ${path} ${res.status}`);
      assert.equal(res.status, 404, `${method} ${path} -> ${res.status} ${res.type}`);
    }
    assert.equal((await http(origin, '/api/health')).status, 200);
    assert.equal((await http(origin, '/')).status, 200);
    return seen.length + ' paths';
  });

  const sources = {};
  await check('Clients on different source addresses do not share a limiter bucket', async () => {
    sources.host = [];
    for (let i = 0; i < 22; i++) sources.host.push((await rescue(origin)).status);
    assert.ok(sources.host.slice(0, 20).every(s => s !== 429) && sources.host[20] === 429, 'the host client should be limited at its 21st request: ' + sources.host);
    sources.notification = await rescueFrom('notification-api', 2);
    sources.clinic = await rescueFrom('clinic-api', 2);
    assert.ok(sources.notification[0] !== 429 && sources.clinic[0] !== 429, `other containers answered ${sources.notification} and ${sources.clinic} while the host was limited`);
    // Prove the sources are really different: nginx logged each one's own address.
    const log = await compose('logs', '--no-color', 'frontend'), seen = new Set([...log.matchAll(/(\d+\.\d+\.\d+\.\d+) - - \[/g)].map(m => m[1]));
    const address = async service => { const [c] = JSON.parse(await docker(['inspect', (await compose('ps', '-q', service)).trim()])); return Object.values(c.NetworkSettings.Networks)[0].IPAddress; };
    const [notificationIp, clinicIp] = [await address('notification-api'), await address('clinic-api')];
    assert.ok(notificationIp !== clinicIp && seen.has(notificationIp) && seen.has(clinicIp), `nginx saw ${[...seen]}; containers are ${notificationIp}, ${clinicIp}`);
    return `nginx saw ${[...seen].join(', ')}`;
  });
  await check('A forged X-Forwarded-For neither dodges nor shares a limiter bucket', async () => {
    const forged = [];
    for (let i = 0; i < 3; i++) forged.push((await rescue(origin, { 'x-forwarded-for': '203.0.113.' + (100 + i), 'x-real-ip': '198.51.100.7', forwarded: 'for=192.0.2.9' })).status);
    assert.deepEqual(forged, [429, 429, 429], 'a limited client changed bucket with a forged header');
    // A fresh source sending a different forged address each time still hits its own limit at the 21st request.
    const spread = await rescueFrom('core-billing', 21, true);
    assert.ok(spread.slice(0, 20).every(s => s !== 429) && spread[20] === 429, 'a client rotating forged addresses was not held to one bucket: ' + spread);
    // Straight to the API port the peer is the Docker gateway, not the trusted frontend, so the header is ignored there too.
    const direct = [];
    for (let i = 0; i < 22; i++) direct.push((await rescue(coreOrigin, { 'x-forwarded-for': '203.0.113.' + (150 + i) })).status);
    assert.ok(direct.filter(s => s !== 429).length <= 20 && direct.at(-1) === 429, 'direct requests rotating forged addresses were not held to one bucket: ' + direct);
    return 'forged headers kept on one bucket in all three paths';
  });
  failed = results.some(r => r.result === 'FAIL');
} catch (error) {
  failed = true;
  results.push({ name: 'harness', result: 'FAIL', detail: String(error.output ?? error.stack).slice(-1500) });
  console.error(String(error.output ?? error.stack).slice(-1500));
} finally {
  appendFileSync(log, await compose('logs', '--no-color').catch(() => 'Logs unavailable\n'));
  // A passing run removes its own project (containers, volumes, built images); a failing one is only stopped, for diagnosis.
  const cleanup = failed ? ['stop'] : ['down', '--volumes', '--rmi', 'local', '--remove-orphans'];
  if (cleanup[0] === 'down') assert.ok(project.startsWith('pet-k0-'));
  await compose(...cleanup).catch(() => { failed = true; console.error('Could not clean up project ' + project); });
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify({ project, network: prefix + '.0/24', result: failed ? 'FAIL' : 'PASS', results }, null, 2));
  console.log(`${results.filter(r => r.result === 'PASS').length}/${results.length} ingress checks PASS; project ${project} ${failed ? 'stopped' : 'removed'}; evidence ${dir}`);
}
if (failed) process.exitCode = 1;
