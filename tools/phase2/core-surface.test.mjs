import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer, request as httpRequest} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createCoreApp} from '../../backend/dist/src/composition/coreApp.js';
import {AppointmentInvoiceBilling} from '../../backend/dist/src/composition/appointmentBilling.js';
import {signToken} from '../../backend/dist/src/lib/token.js';
import {BusinessError} from '../../backend/dist/src/domain/error.js';

// K3 characterization test: what Core's HTTP surface decides, recorded on the real production composition (createCoreApp) with
// a fake database and fake Clinic and Notification services. No Docker; needs `npm run phase2:build`. Golden file:
// tools/phase2/core-surface.golden.json. Every case is `stable`: a refactor that changes one of them changed behavior.
//   legacy  : createCoreApp with no runtime (no REDIS_URL): the monolith as index.ts boots it; the tail is createApp.
//   domains : createCoreApp with the real runtime (limiter on its local fallback) and no split services; the tail is createCoreDomains.
//   split   : domains plus RSA keys and the Clinic and Notification services (stubs): directory, dashboards, proxy, billing.
// Groups: sweep (every OpenAPI operation x 3 configurations x no token / admin: status only), mw (middleware order),
// acct (the currentAccount branches), err (the error handlers), health, cfg (startup refusals), dir (/internal/directory),
// send (authorize-send), bill (appointment billing over HTTP and the internal evidence route), saga (AppointmentInvoiceBilling
// on an in-memory double: request hash, terminal transaction, resume, reconcile).
// The golden file is never rewritten by the test: it was recorded once, on the code before K3 moved anything (commit C1), and a refactor of
// K3 must leave it byte-identical. A legitimate change of behavior edits the golden file by hand, in the commit that changes the behavior.
const GOLDEN = new URL('./core-surface.golden.json', import.meta.url);
const OPENAPI = JSON.parse(readFileSync(new URL('../../backend/openapi.json', import.meta.url), 'utf8'));

// ---- environment --------------------------------------------------------------------------------
const ENV_NAMES = ['CORS_ORIGIN', 'JWT_SECRET', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_KEY_ID', 'JWT_EXPIRES_IN',
  'PHASE2_RUNTIME_REQUIRED', 'REDIS_URL', 'REDIS_TIMEOUT_MS', 'OBSERVABILITY_TOKEN', 'RATE_LIMIT_KEY_SECRET', 'RATE_LIMIT_NAMESPACE',
  'LOCAL_LIMITER_MAX_ENTRIES', 'TRUST_PROXY_CIDRS', 'TRUST_PROXY_HOPS', 'VNPAY_ENABLED', 'VNPAY_HASH_SECRET', 'VNPAY_RETURN_URL', 'VNPAY_TMN_CODE',
  'CLINIC_SERVICE_URL', 'CLINIC_SERVICE_TOKEN', 'CLINIC_BILLING_TOKEN', 'NOTIFICATION_SERVICE_URL', 'NOTIFICATION_SERVICE_TOKEN',
  'CORE_DIRECTORY_TOKEN', 'CORE_BILLING_EVIDENCE_TOKEN', 'CORE_NOTIFICATION_SEND_TOKEN', 'SERVICE_INSTANCE_ID', 'OUTBOX_SOFT_LIMIT',
  'OUTBOX_HARD_LIMIT', 'HTTP_DEADLINE_MS', 'BROKER_URL', 'BROKER_PREFIX', 'BROKER_PROBE_TIMEOUT_MS', 'DATABASE_URL'];
const ENV_PATTERN = /^(BANK_TRANSFER_|API_(READ|WRITE)_|(CLINIC|NOTIFICATION)_GATEWAY_BREAKER_)/;
const savedEnv = {...process.env};
function useEnv(overrides) {
  for (const name of Object.keys(process.env)) if (ENV_NAMES.includes(name) || ENV_PATTERN.test(name)) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
test.after(() => { for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name]; Object.assign(process.env, savedEnv); });
const credential = name => (name + '-credential-').padEnd(48, 'x');
const TOKENS = {directory: credential('directory'), billing: credential('clinic-billing'), evidence: credential('evidence'), notification: credential('notification-send')};
const nameOfToken = value => value === undefined ? 'none' : Object.entries(TOKENS).find(([, v]) => v === value)?.[0] ?? 'other';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const ENV = {
  legacy: {CORS_ORIGIN: 'https://ui.test', JWT_SECRET: 'core-surface-fixture-jwt-secret-0123456789abcdef'},
  runtime: {REDIS_URL: 'redis://127.0.0.1:1', OBSERVABILITY_TOKEN: credential('metrics'), RATE_LIMIT_KEY_SECRET: credential('limiter'), RATE_LIMIT_NAMESPACE: 'core-surface-test'},
  rsa: {JWT_PRIVATE_KEY: privateKey.export({type: 'pkcs8', format: 'pem'}), JWT_PUBLIC_KEY: publicKey.export({type: 'spki', format: 'pem'}), JWT_ISSUER: 'surface-fixture', JWT_AUDIENCE: 'surface-fixture', JWT_KEY_ID: 'fixture'},
};
const envFor = cfg => ({...ENV.legacy, ...(cfg === 'legacy' ? {} : ENV.runtime), ...(cfg === 'split' ? ENV.rsa : {})});
const CONFIGS = ['legacy', 'domains', 'split'];

// ---- scrubbing: ids and clocks never reach the golden ----------------------------------------------
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const DASHLESS = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g; // a transfer content is the invoice code without its dashes
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
function scrubber({nowIsDynamic = true} = {}) {
  const ids = new Map();
  const text = s => {
    const id = m => { if (!ids.has(m)) ids.set(m, ids.size + 1); return '<uuid#' + ids.get(m) + '>'; };
    let out = s.replace(UUID, id).replace(DASHLESS, m => id(m.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'))).replace(JWT, '<jwt>');
    if (nowIsDynamic) out = out.replace(ISO, m => Math.abs(Date.parse(m) - Date.now()) < 3 * 86400000 ? '<now>' : m);
    return out;
  };
  const walk = value => {
    if (typeof value === 'string') return text(value);
    if (value instanceof Date) return text(value.toISOString());
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [text(k), walk(v)]));
    return value;
  };
  return walk;
}

// ---- the fake database -------------------------------------------------------------------------------
const T0 = new Date('2030-01-01T00:00:00.000Z');
const person = (id, role, extra = {}) => ({id, role, fullName: 'Name ' + id, username: null, phone: '', email: null, address: null, avatarUrl: null, createdAt: T0, updatedAt: T0, passwordHash: 'h', passwordSalt: 's', directoryRevision: 3, passwordChangedAt: null, ...extra});
const pet = (id, ownerId) => ({id, ownerId, name: 'Pet ' + id, species: 'dog', breed: null, gender: 'unknown', ageLabel: null, weightKg: null, microchipId: null, avatarUrl: null, healthStatus: 'healthy', allergies: [], notes: null, identifyingMarks: null, lastSeenLocation: null, qrToken: null, qrEnabled: true, showOwnerPhone: true, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: true, rescueNote: null, directoryRevision: 2});
function makeWorld({verbose = false} = {}) {
  const world = {
    verbose, users: new Map(), pets: new Map(), ops: new Map(), invoices: [], events: [], tombstones: new Map(),
    down: false, failAfterAccount: null, failOn: null,
    probe: {pending: 0, outboxAgeSeconds: 0, outboxRetries: 0, billingPending: 0, billingAgeSeconds: 0, dbLockWaits: 0},
    save: () => ({ops: new Map([...world.ops].map(([k, v]) => [k, {...v}])), invoices: [...world.invoices], events: [...world.events]}),
    restore: saved => { world.ops = saved.ops; world.invoices = saved.invoices; world.events = saved.events; },
  };
  for (const [id, role] of [['owner-1', 'owner'], ['owner-2', 'owner'], ['staff-1', 'staff'], ['admin-1', 'admin'], ['doctor-1', 'doctor'], ['staff-9', 'staff']]) world.users.set(id, person(id, role));
  for (const [id, owner] of [['pet-1', 'owner-1'], ['pet-2', 'owner-2'], ['pet-3', 'staff-9']]) world.pets.set(id, pet(id, owner));
  return world;
}
// A token for `revoked-admin-1` finds an account whose password changed later; `swapped-admin-1` an account of another role.
function userRow(world, id) {
  if (world.users.has(id)) return world.users.get(id);
  const m = /^(revoked-|swapped-)?(owner|doctor|staff|admin)-/.exec(id);
  if (!m) return null;
  if (m[1] === 'revoked-') return person(id, m[2], {passwordChangedAt: new Date('2999-01-01T00:00:00Z')});
  if (m[1] === 'swapped-') return person(id, m[2] === 'owner' ? 'admin' : 'owner');
  return person(id, m[2]);
}
function matches(world, row, where = {}) {
  for (const [key, want] of Object.entries(where)) {
    if (key === 'OR') { if (!want.some(clause => matches(world, row, clause))) return false; continue; }
    if (key === 'pets') { const ids = want.some?.id?.in; if (ids && ![...world.pets.values()].some(p => p.ownerId === row.id && ids.includes(p.id))) return false; continue; }
    const value = row[key];
    if (want && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
      if ('in' in want && !want.in.includes(value)) return false;
      if ('not' in want && value === want.not) return false;
      if ('gt' in want && !(value > want.gt)) return false;
      continue;
    }
    if (value !== want) return false;
  }
  return true;
}
const notFound = () => Object.assign(new Error('No record found'), {code: 'P2025'});
const duplicate = () => Object.assign(new Error('Unique constraint failed'), {code: 'P2002'});
const pick = (row, select) => row && select ? Object.fromEntries(Object.entries(select).filter(([key, on]) => on === true && key in row).map(([key]) => [key, row[key]])) : row;
function rows(world, list, args) {
  let out = list.filter(row => matches(world, row, args.where));
  if (args.orderBy?.id) out = [...out].sort((a, b) => a.id.localeCompare(b.id));
  if (args.take) out = out.slice(0, args.take);
  return out.map(row => pick(row, args.select));
}
const applyData = (row, data = {}) => {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    row[key] = value && typeof value === 'object' && 'increment' in value ? (row[key] ?? 0) + value.increment : value;
  }
  return row;
};
function answer(world, model, method, args) {
  if (model === 'user') {
    if (method === 'findUnique') return pick(userRow(world, args.where?.id), args.select);
    if (method === 'findFirst') return rows(world, [...world.users.values()], args)[0] ?? null;
    if (method === 'findMany') return rows(world, [...world.users.values()], args);
    if (method === 'count') return rows(world, [...world.users.values()], args).length;
  }
  if (model === 'pet') {
    const list = [...world.pets.values()];
    if (method === 'findUnique') return world.pets.get(args.where?.id) ?? null;
    if (method === 'findFirst') return rows(world, list, args)[0] ?? null;
    if (method === 'findMany') return rows(world, list, args);
    if (method === 'count') return rows(world, list, args).length;
  }
  if (model === 'appointmentBillingOperation') {
    const byKey = args.where?.actorId_operationType_idempotencyKey;
    if (method === 'findUnique') return (byKey ? [...world.ops.values()].find(o => o.actorId === byKey.actorId && o.operationType === byKey.operationType && o.idempotencyKey === byKey.idempotencyKey) : world.ops.get(args.where?.id)) ?? null;
    if (method === 'findUniqueOrThrow') { const op = world.ops.get(args.where.id); if (!op) throw notFound(); return op; }
    if (method === 'update') { const op = world.ops.get(args.where.id); if (!op) throw notFound(); return applyData(op, args.data); }
    if (method === 'updateMany') { const hit = [...world.ops.values()].filter(o => matches(world, o, args.where)); hit.forEach(o => applyData(o, args.data)); return {count: hit.length}; }
  }
  if (model === 'invoice') {
    if (method === 'findUnique') return world.invoices.find(i => args.where.appointmentId ? i.appointmentId === args.where.appointmentId : i.id === args.where.id) ?? null;
    if (method === 'findUniqueOrThrow') { const invoice = world.invoices.find(i => i.id === args.where.id); if (!invoice) throw notFound(); return invoice; }
    if (method === 'create') {
      if (args.data.appointmentId && world.invoices.some(i => i.appointmentId === args.data.appointmentId)) throw duplicate();
      const {items, ...data} = args.data;
      const invoice = {...data, status: 'pending', transferCode: null, createdAt: new Date(), updatedAt: new Date(), items: (items?.create ?? []).map((line, n) => ({id: 'line-' + (n + 1), ...line}))};
      world.invoices.push(invoice);
      return invoice;
    }
  }
  if (model === 'outboxEvent' && method === 'create') { world.events.push(args.data); return args.data; }
  if (method.endsWith('OrThrow')) throw notFound();
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (['create', 'update', 'upsert', 'delete'].includes(method)) return {id: 'new-1', ...(args.data ?? {})};
  if (method === 'updateMany' || method === 'deleteMany') return {count: 0};
  return null;
}
function raw(world, key, sql, values) {
  if (sql.includes('INSERT INTO "AppointmentBillingOperation"')) {
    const [id, actorId, actorRole, operationType, idempotencyKey, requestHash, appointmentId, payload, expectedRevision] = values;
    const all = [...world.ops.values()];
    if (all.some(o => o.actorId === actorId && o.operationType === operationType && o.idempotencyKey === idempotencyKey) || all.some(o => o.appointmentId === appointmentId && o.state === 'PREPARING')) return 0;
    const now = new Date();
    world.ops.set(id, {id, actorId, actorRole, operationType, idempotencyKey, requestHash, appointmentId, payload: JSON.parse(payload), expectedRevision, state: 'PREPARING', invoiceId: null, snapshot: null, errorCode: null, errorStatus: null, createdAt: now, updatedAt: now, terminalAt: null, finalizedAt: null, attempts: 0, nextAttemptAt: now, leaseOwner: null, leaseUntil: null});
    return 1;
  }
  if (sql.includes('FOR UPDATE SKIP LOCKED')) {
    const [filter, , limit] = values, now = Date.now();
    return [...world.ops.values()].filter(o => (filter === null || o.id === filter) && o.finalizedAt === null && o.nextAttemptAt.getTime() <= now && (o.leaseUntil === null || o.leaseUntil.getTime() < now))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, limit).map(o => ({id: o.id}));
  }
  if (sql.includes('FOR UPDATE')) return world.ops.has(values[0]) ? [{id: values[0]}] : [];
  if (sql.includes('FROM "OutboxEvent"')) { const found = world.tombstones.get(values[1] + '|' + values[0]); return found ? [{payload: found}] : []; }
  return key === '$executeRaw' || key === '$executeRawUnsafe' ? 1 : [];
}
function makeDb(world, log) {
  const record = (name, args) => log.push(world.verbose ? {call: name, args} : name);
  const gate = name => {
    if (world.down) throw new Error('database down');
    const failure = world.failOn?.(name);
    if (failure) throw failure;
    if (world.failAfterAccount && name !== 'user.findUnique') throw world.failAfterAccount;
  };
  const db = new Proxy({}, {get(_target, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined;
    if (key === '$transaction') return async (work, options) => {
      if (options?.maxWait === 1500) return world.probe; // the runtime's own readiness probe, not a request
      gate('$transaction');
      record('$transaction' + (options?.isolationLevel ? '(' + options.isolationLevel + ')' : ''), []);
      if (Array.isArray(work)) return Promise.all(work);
      const saved = world.save();
      try { return await work(db); } catch (error) { world.restore(saved); throw error; }
    };
    if (key.startsWith('$')) return async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      gate(key);
      record(key, [sql, ...values]);
      return raw(world, key, sql, values);
    };
    return new Proxy({}, {get(_model, method) {
      if (method === 'then' || typeof method === 'symbol') return undefined;
      return async (args = {}) => {
        const name = key + '.' + method;
        gate(name);
        record(name, [args]);
        return answer(world, key, method, args);
      };
    }});
  }});
  return db;
}

// ---- Clinic and Notification stubs, and the booted applications -------------------------------------------
const snapshotOf = (id, extra = {}) => ({appointmentId: id, revision: 3, ownerId: 'owner-1', petId: 'pet-1', type: id.startsWith('spa-bath') ? 'spa_bath' : 'general_checkup', serviceName: 'Service', clinicName: 'Clinic', date: '2030-01-02', time: '09:00', ...extra});
async function startStub(name) {
  const stub = {calls: [], mode: 'ok', url: ''};
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const svc = req.headers['x-service-token'];
    stub.calls.push(`${name} ${req.method} ${req.url} bearer=${Boolean(req.headers.authorization)} svc=${nameOfToken(svc)}${req.headers['idempotency-key'] ? ' key=' + req.headers['idempotency-key'] : ''}${body ? ' ' + (body.length > 200 ? body.slice(0, 200) + '...[' + body.length + ' bytes]' : body) : ''}`);
    let reply = {status: 200, body: {stub: name}};
    if (stub.mode === 'down') reply = {status: 503, body: {error: 'stub down'}};
    else if (name === 'clinic') {
      let m;
      if ((m = /^\/internal\/billing-sources\/([^/]+)$/.exec(req.url))) reply.body = {snapshot: snapshotOf(decodeURIComponent(m[1]))};
      else if (/^\/internal\/billing-reservations\/[^/]+$/.test(req.url) && req.method === 'PUT') { const data = JSON.parse(body); reply.body = {snapshot: snapshotOf(data.appointmentId, {revision: data.expectedRevision})}; }
      else if (/^\/internal\/billing-reservations\/[^/]+\/(commit|release)$/.test(req.url)) reply.body = {};
    }
    res.writeHead(reply.status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(reply.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  stub.url = 'http://127.0.0.1:' + server.address().port;
  stub.close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return stub;
}
async function localLimiter(app) {
  const rt = app.locals.runtime;
  rt.limiter.spend = async (group, buckets) => rt.limiter.localRead(group, buckets);
  rt.limiter.ping = async () => true;
  rt.brokerProbe = async () => true;
  await rt.start(); // writes need fresh evidence of the database (limitPolicy.ts)
}
async function boot(cfg, world = makeWorld()) {
  useEnv(envFor(cfg));
  const log = [], db = makeDb(world, log), inst = {cfg, world, log, stubs: {}};
  const config = {};
  if (cfg === 'split') {
    inst.stubs.clinic = await startStub('clinic'); inst.stubs.notification = await startStub('notification');
    Object.assign(config, {clinicUrl: inst.stubs.clinic.url, clinicToken: TOKENS.billing, notificationUrl: inst.stubs.notification.url, notificationToken: TOKENS.notification, directoryToken: TOKENS.directory, evidenceToken: TOKENS.evidence});
  }
  const app = createCoreApp(db, config);
  inst.rt = app.locals.runtime;
  assert.equal(Boolean(inst.rt), cfg !== 'legacy', cfg + ' runs the runtime only when REDIS_URL is set');
  if (inst.rt) await localLimiter(app);
  inst.server = app.listen(0, '127.0.0.1');
  await once(inst.server, 'listening');
  inst.base = 'http://127.0.0.1:' + inst.server.address().port;
  inst.close = async () => {
    inst.rt?.close(); inst.server.closeAllConnections(); await new Promise(resolve => inst.server.close(resolve));
    for (const stub of Object.values(inst.stubs)) await stub.close();
  };
  return inst;
}

// ---- requests and observations -------------------------------------------------------------------------
const quietStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => String(chunk).includes('UNEXPECTED_APPLICATION_ERROR') ? true : quietStderr(chunk, ...rest);
console.error = () => {};
// The runtime writes one log line per request, and the billing route one per operation.
const quietStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => /^\{"service":"core"/.test(typeof chunk === 'string' ? chunk : '') ? true : quietStdout(chunk, ...rest);
const bearerOf = auth => {
  if (auth === undefined || auth === 'none') return null;
  if (typeof auth === 'string') return 'Bearer ' + signToken(auth + '-1', auth);
  if (auth.raw !== undefined) return auth.raw;
  return 'Bearer ' + signToken(auth.sub, auth.role);
};
function sendOnce(base, {method = 'GET', path, auth, headers = {}, body, raw, bytes}) {
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : bytes !== undefined ? JSON.stringify({pad: 'x'.repeat(bytes)}) : undefined;
  const bearer = bearerOf(auth);
  const h = {...(bearer ? {Authorization: bearer} : {}), ...(payload !== undefined ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)} : {}), ...headers};
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = httpRequest(base + path, {method, headers: h, agent: false, timeout: 20000}, res => {
      answered = true;
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({status: res.statusCode, headers: res.headers, json, text}); });
    });
    req.on('error', error => { if (!answered) reject(error); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function send(base, step) {
  try { return await sendOnce(base, step); } catch (error) { if (!/ECONNRESET|EPIPE/.test(String(error.code))) throw error; return sendOnce(base, step); } // a refused huge body may reset the socket
}
const HEADERS = ['x-powered-by', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers', 'access-control-allow-methods', 'access-control-allow-headers', 'vary', 'cache-control', 'retry-after', 'x-service-degraded', 'x-content-type-options', 'location'];
function pickHeaders(headers) {
  const out = {};
  for (const name of HEADERS) if (headers[name] !== undefined) out[name] = headers[name];
  const csp = headers['content-security-policy'];
  if (csp !== undefined) out.csp = csp.startsWith("default-src 'self';base-uri 'self'") ? 'helmet' : csp;
  const type = headers['content-type'];
  if (type !== undefined) out.type = /json/.test(type) ? 'json' : /html/.test(type) ? 'html' : /text\/plain/.test(type) ? 'text' : type;
  return out;
}
function bodyOf(res, scrub) {
  if (res.json !== undefined) { const value = scrub(res.json), length = JSON.stringify(value).length; return length > 1500 ? {'[large json]': Object.keys(value).slice(0, 12)} : value; }
  if (/html/.test(res.headers['content-type'] ?? '')) return '[html]';
  return res.text.length > 120 ? '[text]' : scrub(res.text);
}
// One request, one observation: status, body, selected headers, the database calls and the downstream calls it caused.
async function observe(inst, step, {dbLog = true} = {}) {
  const {world, log} = inst, saved = {down: world.down, failAfterAccount: world.failAfterAccount, failOn: world.failOn};
  Object.assign(world, step.world ?? {});
  log.length = 0; for (const stub of Object.values(inst.stubs)) { stub.calls.length = 0; if (step.stub) stub.mode = step.stub; }
  let res;
  try { res = await send(inst.base, step); } finally { Object.assign(world, saved); for (const stub of Object.values(inst.stubs)) stub.mode = 'ok'; }
  const scrub = scrubber(), calls = Object.values(inst.stubs).flatMap(stub => stub.calls);
  return {status: res.status, body: bodyOf(res, scrub), headers: scrub(pickHeaders(res.headers)), ...(dbLog && log.length ? {db: [...log]} : {}), ...(calls.length ? {stub: calls.map(scrub)} : {})};
}

// ---- the cases -----------------------------------------------------------------------------------------
const observed = {}, groupOf = {};
const record = (group, name, value) => { assert.ok(!(name in observed), 'duplicate case ' + name); observed[name] = value; groupOf[name] = group; };
const step = (inst, group, name, spec, options) => observe(inst, spec, options).then(value => record(group, `${group} ${inst.cfg} ${name}`, value));

// 1. sweep: every operation of backend/openapi.json, every configuration, without a token and as admin (status only).
const OPERATIONS = Object.entries(OPENAPI.paths).flatMap(([path, methods]) => Object.keys(methods).filter(m => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(m => [m.toUpperCase(), path]));
assert.equal(OPERATIONS.length, 75, 'backend/openapi.json declares 75 operations');
const concrete = path => '/api' + path.replace('{roomType}', 'standard').replace('{token}', 'tok-1').replace(/\{[^}]+\}/g, 'x-1');
async function sweep(inst) {
  for (const auth of ['none', 'admin']) for (const [method, path] of OPERATIONS) {
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? {body: {}} : {};
    const res = await send(inst.base, {method, path: concrete(path), auth, headers: {'Idempotency-Key': 'sweep-key-1'}, ...body});
    record('sweep', `sweep ${inst.cfg} ${auth} ${method} ${concrete(path)}`, res.status);
  }
}

// 2. middleware order: bodies, CORS, docs, 404, bootstrap.
async function middleware(inst) {
  const bodies = [['broken JSON', {raw: '{'}], ['array', {raw: '[]'}], ['string', {raw: '"x"'}], ['empty body', {raw: ''}], ['empty object', {raw: '{}'}], ['17kb', {bytes: 17000}], ['100kb', {bytes: 100000}]];
  for (const [method, path] of [['POST', '/api/auth/owner/login'], ['POST', '/api/pets'], ['POST', '/api/notifications/send'], ['POST', '/api/appointments']])
    for (const auth of ['none', 'admin']) for (const [label, body] of bodies) await step(inst, 'mw', `${method} ${path} ${auth} ${label}`, {method, path, auth, ...body});
  await step(inst, 'mw', 'POST /api/pets 11mb', {method: 'POST', path: '/api/pets', auth: 'admin', bytes: 11 * 1024 * 1024});
  await step(inst, 'mw', 'POST /api/appointments 9mb', {method: 'POST', path: '/api/appointments', auth: 'admin', bytes: 9 * 1024 * 1024});
  for (const path of ['/api/auth/owner/login', '/api/pets', '/api/notifications', '/api/appointments', '/api/health'])
    for (const origin of ['https://ui.test', 'https://evil.test'])
      await step(inst, 'mw', `OPTIONS ${path} from ${origin}`, {method: 'OPTIONS', path, headers: {Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'}});
  await step(inst, 'mw', 'OPTIONS without Origin', {method: 'OPTIONS', path: '/api/pets'});
  for (const [label, path, auth] of [['health', '/api/health', 'none'], ['pets admin', '/api/pets', 'admin'], ['unknown route', '/api/nope', 'none'], ['notifications admin', '/api/notifications', 'admin']])
    for (const origin of ['https://ui.test', 'https://evil.test']) await step(inst, 'mw', `GET ${label} from ${origin}`, {path, auth, headers: {Origin: origin}});
  await step(inst, 'mw', 'GET /api/docs/', {path: '/api/docs/'});
  await step(inst, 'mw', 'GET /api/docs', {path: '/api/docs'});
  await step(inst, 'mw', 'GET /api/openapi.json', {path: '/api/openapi.json'});
  for (const [label, spec] of [['GET /api/nope none', {path: '/api/nope'}], ['GET /api/nope admin', {path: '/api/nope', auth: 'admin'}], ['GET /nope', {path: '/nope'}], ['GET /', {path: '/'}], ['GET /api', {path: '/api'}],
    ['GET /internal/nope', {path: '/internal/nope'}], ['POST /api/nope with an array', {method: 'POST', path: '/api/nope', raw: '[]'}], ['POST /api/nope with broken JSON', {method: 'POST', path: '/api/nope', raw: '{'}],
    ['PUT /api/nope with a string', {method: 'PUT', path: '/api/nope', raw: '"x"'}], ['DELETE /api/pets/x-1 admin', {method: 'DELETE', path: '/api/pets/x-1', auth: 'admin'}],
    ['GET percent-malformed path', {path: '/api/pets/%E0%A4%A', auth: 'admin'}], ['GET /API/pets (case)', {path: '/API/pets', auth: 'admin'}], ['GET /api/pets/ (slash)', {path: '/api/pets/', auth: 'admin'}]])
    await step(inst, 'mw', label, spec);
  for (const auth of ['none', 'owner', 'admin']) await step(inst, 'mw', `GET /api/bootstrap ${auth}`, {path: '/api/bootstrap', auth});
  await step(inst, 'mw', 'Basic scheme', {path: '/api/pets', auth: {raw: 'Basic abc'}});
}

// 3. the branches of currentAccount.
async function accounts(inst) {
  const get = (label, spec) => step(inst, 'acct', label, {path: '/api/pets', ...spec});
  await get('no Authorization header', {});
  await get('Bearer with a bad token', {auth: {raw: 'Bearer not-a-token'}});
  await get('Bearer token of 8192 characters', {auth: {raw: 'Bearer ' + 'a'.repeat(8185)}});
  await get('valid admin', {auth: 'admin'});
  await get('account missing', {auth: {sub: 'ghost-1', role: 'admin'}});
  await get('role changed', {auth: {sub: 'swapped-admin-1', role: 'admin'}});
  await get('password changed after the token', {auth: {sub: 'revoked-admin-1', role: 'admin'}});
  await get('database down', {auth: 'admin', world: {down: true}});
  for (const path of ['/api/auth/owner/login', '/api/public/pets/tok-1', '/api/health', '/api/openapi.json', '/api/docs/', '/api/payments/vnpay/ipn', '/api/payments/vnpay/return', '/api/payments/vnpay/reconcile'])
    await step(inst, 'acct', `bad Bearer on ${path}`, {path, auth: {raw: 'Bearer not-a-token'}});
  await step(inst, 'acct', 'OPTIONS with a bad Bearer', {method: 'OPTIONS', path: '/api/pets', auth: {raw: 'Bearer not-a-token'}, headers: {Origin: 'https://ui.test', 'Access-Control-Request-Method': 'GET'}});
  await step(inst, 'acct', 'me with a missing account', {path: '/api/auth/me', auth: {sub: 'ghost-1', role: 'admin'}});
}

// 4. the error handlers.
async function errors(inst) {
  const transient = Object.assign(new Error('connection'), {code: 'P1001'});
  await step(inst, 'err', 'unexpected error after the account check', {path: '/api/pets', auth: 'admin', world: {failAfterAccount: new Error('boom')}});
  await step(inst, 'err', 'transient error after the account check', {path: '/api/pets', auth: 'admin', world: {failAfterAccount: transient}});
  const pet = {ownerId: 'owner-1', name: 'Pet', species: 'dog'};
  await step(inst, 'err', 'unexpected error on a write', {method: 'POST', path: '/api/pets', auth: 'admin', body: pet, world: {failAfterAccount: new Error('boom')}});
  await step(inst, 'err', 'transient error on a write', {method: 'POST', path: '/api/pets', auth: 'admin', body: pet, world: {failAfterAccount: transient}});
  await step(inst, 'err', 'unexpected error on a public route', {path: '/api/public/pets/tok-1', world: {failAfterAccount: new Error('boom')}});
  await step(inst, 'err', 'transient error on a public route', {path: '/api/public/pets/tok-1', world: {failAfterAccount: transient}});
  await step(inst, 'err', 'a business error (unknown pet)', {method: 'PATCH', path: '/api/pets/x-1', auth: 'admin', body: {name: 'N'}});
  await step(inst, 'err', 'a business error (forbidden)', {method: 'PATCH', path: '/api/pets/pet-2', auth: 'owner', body: {name: 'N'}});
  await step(inst, 'err', 'login with a missing account', {method: 'POST', path: '/api/auth/admin/login', body: {username: 'ghost', password: 'wrong-password-1'}});
  await step(inst, 'err', 'login with invalid input', {method: 'POST', path: '/api/auth/admin/login', body: {username: 5}});
  await step(inst, 'err', 'login with a database error', {method: 'POST', path: '/api/auth/admin/login', body: {username: 'ghost', password: 'wrong-password-1'}, world: {failAfterAccount: new Error('boom')}});
  await step(inst, 'err', 'owner login with a transient error', {method: 'POST', path: '/api/auth/owner/login', body: {email: 'a@example.test', password: 'wrong-password-1'}, world: {failAfterAccount: transient}});
}

// 5. health and metrics.
async function health(inst) {
  await step(inst, 'health', 'GET /api/health', {path: '/api/health'});
  await step(inst, 'health', 'GET /api/health with the database down', {path: '/api/health', world: {down: true}});
  for (const path of ['/health/live', '/health/ready']) await step(inst, 'health', 'GET ' + path, {path});
  await step(inst, 'health', 'GET /metrics without a token', {path: '/metrics'});
  await step(inst, 'health', 'GET /metrics with a wrong token', {path: '/metrics', headers: {'X-Service-Token': 'wrong'}});
  await step(inst, 'health', 'GET /metrics with the token', {path: '/metrics', headers: {'X-Service-Token': ENV.runtime.OBSERVABILITY_TOKEN}});
}

// 6. /internal/directory (domains: no credential is configured; split: the credential is TOKENS.directory).
const svc = value => ({'X-Service-Token': value});
async function directory(inst) {
  const ask = (label, spec) => step(inst, 'dir', label, {method: 'POST', path: '/internal/directory/authorize', headers: svc(TOKENS.directory), auth: 'staff', body: {}, ...spec});
  if (inst.cfg !== 'split') {
    await ask('no credential configured', {}); await ask('no credential configured, no token', {headers: {}});
    await step(inst, 'dir', 'export, no credential configured', {path: '/internal/directory/export?kind=owner', headers: svc(TOKENS.directory)});
    return;
  }
  await ask('without a service token', {headers: {}}); await ask('wrong service token', {headers: svc('wrong')});
  await ask('service token of 600 characters', {headers: svc('x'.repeat(600))}); await ask('another service credential', {headers: svc(TOKENS.billing)});
  await ask('broken JSON with a wrong credential', {headers: svc('wrong'), body: undefined, raw: '{'}); await ask('broken JSON', {body: undefined, raw: '{'});
  await ask('65kb body', {body: undefined, bytes: 65 * 1024}); await ask('array body', {body: undefined, raw: '[]'}); await ask('null body', {body: undefined, raw: 'null'});
  await ask('no bearer', {auth: 'none'}); await ask('Basic scheme', {auth: {raw: 'Basic abc'}}); await ask('bad bearer', {auth: {raw: 'Bearer nope'}}); await ask('bearer of 8200 characters', {auth: {raw: 'Bearer ' + 'a'.repeat(8200)}});
  for (const [label, body] of [['unknown key', {x: 1}], ['petIds not an array', {petIds: 'pet-1'}], ['petIds with 101 ids', {petIds: Array.from({length: 101}, (_, n) => 'p' + n)}], ['petIds with an empty id', {petIds: ['']}], ['petIds with a number', {petIds: [1]}],
    ['petIds with a 201-character id', {petIds: ['a'.repeat(201)]}], ['ownerIds not an array', {ownerIds: {}}], ['doctorId a number', {doctorId: 5}], ['doctorId empty', {doctorId: ''}], ['doctorId 201 characters', {doctorId: 'd'.repeat(201)}]])
    await ask('shape: ' + label, {body});
  const as = (sub, role) => ({sub, role});
  await ask('step 1: account missing (also bad pet)', {auth: as('ghost-1', 'staff'), body: {petIds: ['ghost']}});
  await ask('step 1: role changed', {auth: as('staff-1', 'admin'), body: {petIds: ['ghost']}});
  await step(inst, 'dir', 'step 2: session revoked (also bad pet)',{method: 'POST', path: '/internal/directory/authorize', headers: svc(TOKENS.directory), auth: as('revoked-staff-1', 'staff'), body: {petIds: ['ghost']}});
  await ask('step 3: pet not found', {body: {petIds: ['pet-1', 'ghost']}});
  await ask('step 4: owner asks a foreign pet', {auth: as('owner-1', 'owner'), body: {petIds: ['pet-2']}});
  await ask('step 4: owner asks a foreign owner id', {auth: as('owner-1', 'owner'), body: {ownerIds: ['owner-2']}});
  await ask('step 5: doctor not found (also bad owner)', {body: {petIds: ['pet-1'], ownerIds: ['ghost'], doctorId: 'ghost'}});
  await ask('step 5: a staff account is not a doctor', {body: {doctorId: 'staff-1'}});
  await ask('step 6: owner not found', {body: {petIds: ['pet-1'], ownerIds: ['ghost']}});
  await ask('step 6: pet whose owner is not an owner account', {body: {petIds: ['pet-3']}});
  await ask('200: nothing named', {auth: as('owner-2', 'owner'), body: {}});
  await ask('200: pets, owners and doctor', {body: {petIds: ['pet-1', 'pet-2'], ownerIds: ['owner-2', 'owner-1'], doctorId: 'doctor-1'}});
  await ask('200: owner, own pet', {auth: as('owner-1', 'owner'), body: {petIds: ['pet-1']}});
  await ask('200: owner, own owner id only', {auth: as('owner-1', 'owner'), body: {ownerIds: ['owner-1']}});
  await ask('200: admin, duplicate ids', {auth: as('admin-1', 'admin'), body: {petIds: ['pet-1', 'pet-1'], ownerIds: ['owner-1', 'owner-1']}});
  await ask('200: doctor only', {body: {doctorId: 'doctor-1'}});
  await ask('200: the lookup endpoint shares the handler', {path: '/internal/directory/lookup', body: {petIds: ['pet-2']}});
  await ask('database down', {world: {down: true}});
  await ask('database fails on the pet query', {body: {petIds: ['pet-1']}, world: {failOn: name => name === 'pet.findMany' ? new Error('boom') : undefined}});
  await ask('database fails on the owner query', {body: {ownerIds: ['owner-1']}, world: {failOn: name => name === 'user.findMany' ? new Error('boom') : undefined}});
  const list = (label, query, spec = {}) => step(inst, 'dir', 'export: ' + label, {path: '/internal/directory/export' + query, headers: svc(TOKENS.directory), ...spec});
  await list('no credential', '?kind=owner', {headers: {}}); await list('wrong credential', '?kind=owner', {headers: svc('wrong')});
  await list('no kind', ''); await list('unknown kind', '?kind=doctor'); await list('limit 0', '?kind=owner&limit=0'); await list('limit 101', '?kind=owner&limit=101');
  await list('limit abc', '?kind=owner&limit=abc'); await list('limit 1.5', '?kind=owner&limit=1.5'); await list('cursor of 201 characters', '?kind=owner&cursor=' + 'c'.repeat(201)); await list('empty id', '?kind=owner&id=');
  await list('owners, limit 1', '?kind=owner&limit=1'); await list('owners, limit 2', '?kind=owner&limit=2'); await list('owners after a cursor', '?kind=owner&limit=5&cursor=owner-1');
  await list('pets', '?kind=pet&limit=2'); await list('pets after a cursor', '?kind=pet&cursor=pet-1'); await list('staff', '?kind=staff&limit=10');
  await list('one owner by id', '?kind=owner&id=owner-1'); await list('one pet by id', '?kind=pet&id=pet-2'); await list('an owner id asked as staff', '?kind=staff&id=owner-1');
  inst.world.tombstones.set('directory.owner-upserted.v1|owner-9', {id: 'owner-9', deletedAt: '2030-01-01T00:00:00.000Z', sourceVersion: 7});
  await list('a deleted id with a tombstone', '?kind=owner&id=owner-9'); await list('an unknown id without a tombstone', '?kind=owner&id=ghost'); await list('a tombstone of another kind', '?kind=pet&id=owner-9');
  await list('database down', '?kind=owner', {world: {down: true}});
  await list('database fails on the tombstone query', '?kind=owner&id=ghost', {world: {failOn: name => name === '$queryRaw' ? new Error('boom') : undefined}});
}

// 7. /internal/notifications/authorize-send.
async function authorizeSend(inst) {
  const ask = (label, spec) => step(inst, 'send', label, {method: 'POST', path: '/internal/notifications/authorize-send', headers: svc(TOKENS.notification), auth: 'staff', body: {recipientOwnerId: 'owner-1'}, ...spec});
  if (inst.cfg !== 'split') { await ask('no token configured', {}); await ask('no token configured, wrong token', {headers: svc('wrong')}); return; }
  const as = (sub, role) => ({sub, role});
  await ask('without a service token', {headers: {}}); await ask('wrong service token', {headers: svc('wrong')}); await ask('another service credential', {headers: svc(TOKENS.directory)});
  await ask('wrong token with broken JSON (the body is read first)', {headers: svc('wrong'), body: undefined, raw: '{'}); await ask('broken JSON', {body: undefined, raw: '{'}); await ask('9kb body', {body: undefined, bytes: 9 * 1024});
  await ask('no bearer', {auth: 'none'}); await ask('bad bearer', {auth: {raw: 'Bearer nope'}}); await ask('Basic scheme', {auth: {raw: 'Basic abc'}}); await ask('bearer of 8200 characters', {auth: {raw: 'Bearer ' + 'a'.repeat(8200)}});
  await ask('owner is refused by the matrix', {auth: 'owner'}); await ask('doctor is refused by the matrix', {auth: 'doctor'});
  for (const [label, body] of [['array', undefined], ['no recipient', {}], ['recipient a number', {recipientOwnerId: 5}], ['recipient empty', {recipientOwnerId: ''}], ['recipient 201 characters', {recipientOwnerId: 'o'.repeat(201)}], ['extra key', {recipientOwnerId: 'owner-1', title: 'x'}]])
    await ask('shape: ' + label, label === 'array' ? {body: undefined, raw: '[]'} : {body});
  await ask('sender missing', {auth: as('ghost-1', 'staff')}); await ask('sender role changed', {auth: as('swapped-staff-1', 'staff')});
  await ask('recipient missing', {body: {recipientOwnerId: 'ghost'}}); await ask('recipient is not an owner', {body: {recipientOwnerId: 'staff-1'}});
  await ask('200 as staff', {}); await ask('200 as admin', {auth: 'admin'});
  await ask('database down', {world: {down: true}});
  await ask('database fails on the recipient query', {world: {failOn: name => name === 'user.findUnique' && inst.log.length >= 1 ? new Error('boom') : undefined}});
}

// 8. appointment billing over HTTP (split only) and the internal evidence route.
async function billing(inst) {
  if (inst.cfg !== 'split') {
    for (const path of ['/api/operations/x-1', '/internal/billing-operations/x-1']) await step(inst, 'bill', `GET ${path}`, {path, auth: 'admin', headers: svc(TOKENS.evidence)});
    return;
  }
  const key = {'Idempotency-Key': 'bill-key-1'}, create = (label, spec) => step(inst, 'bill', label, {method: 'POST', path: '/api/invoices', auth: 'staff', headers: key, body: {type: 'appointment', relatedId: 'appt-1', subtotal: 150000}, ...spec});
  await create('create: staff', {});
  await create('create: the same key and charges again', {});
  await create('create: the same key, other charges', {body: {type: 'appointment', relatedId: 'appt-1', subtotal: 99000}});
  await create('create: no Idempotency-Key', {headers: {}});
  await create('create: owner is refused by the matrix', {auth: 'owner'});
  await create('create: appointmentId without type', {body: {appointmentId: 'appt-3', subtotal: 1}, headers: {'Idempotency-Key': 'bill-key-3'}});
  await create('create: invalid source', {body: {appointmentId: 'appt-3'}, headers: {'Idempotency-Key': 'bill-key-4'}});
  await create('create: lines', {body: {type: 'appointment', relatedId: 'appt-4', items: [{description: 'Vaccine', quantity: 2, unitPrice: 50000}], taxAmount: 1000, discountAmount: 500, notes: ' note '}, headers: {'Idempotency-Key': 'bill-key-5'}});
  await create('create: discount over the subtotal', {body: {type: 'appointment', relatedId: 'appt-5', subtotal: 100, discountAmount: 200}, headers: {'Idempotency-Key': 'bill-key-6'}});
  await create('create: a non-appointment body falls through to the invoice routes', {body: {type: 'hotel_booking', relatedId: 'hb-1', subtotal: 1000}, headers: {'Idempotency-Key': 'bill-key-7'}});
  await create('create: 97kb body', {body: undefined, bytes: 97 * 1024, headers: {'Idempotency-Key': 'bill-key-8'}});
  await create('create: no token', {auth: 'none'});
  await create('create: Clinic is down', {body: {type: 'appointment', relatedId: 'appt-6', subtotal: 5000}, headers: {'Idempotency-Key': 'bill-key-9'}, stub: 'down'});
  await create('create: a second operation on the pending appointment', {body: {type: 'appointment', relatedId: 'appt-6', subtotal: 5000}, headers: {'Idempotency-Key': 'bill-key-10'}});
  const checkout = (label, spec) => step(inst, 'bill', label, {method: 'POST', path: '/api/invoices/checkout', auth: 'owner', headers: key, body: {type: 'appointment', relatedId: 'spa-bath-1'}, ...spec});
  await checkout('checkout: owner, fixed rate', {});
  await checkout('checkout: replay', {});
  await checkout('checkout: a service without a fixed rate', {body: {type: 'appointment', relatedId: 'appt-7'}, headers: {'Idempotency-Key': 'bill-key-11'}});
  await checkout('checkout: prices from the client', {body: {type: 'appointment', relatedId: 'spa-bath-2', subtotal: 1}, headers: {'Idempotency-Key': 'bill-key-12'}});
  await checkout('checkout: staff is refused by the matrix', {auth: 'staff'});
  const op = [...inst.world.ops.values()].find(o => o.idempotencyKey === 'bill-key-1'), other = [...inst.world.ops.values()].find(o => o.idempotencyKey === 'bill-key-9');
  for (const [label, spec] of [['GET /api/operations: no token', {path: '/api/operations/' + op.id}], ['GET /api/operations: the actor', {path: '/api/operations/' + op.id, auth: 'staff'}], ['GET /api/operations: another actor', {path: '/api/operations/' + op.id, auth: 'admin'}],
    ['GET /api/operations: a pending operation', {path: '/api/operations/' + other.id, auth: 'staff'}], ['GET /api/operations: unknown', {path: '/api/operations/ghost', auth: 'staff'}], ['GET /api/operations: id of 129 characters', {path: '/api/operations/' + 'a'.repeat(129), auth: 'staff'}]])
    await step(inst, 'bill', label, spec);
  for (const [label, spec] of [['evidence: no token', {headers: {}}], ['evidence: wrong token', {headers: svc('wrong')}], ['evidence: the billing token is not the evidence token', {headers: svc(TOKENS.billing)}], ['evidence: found', {path: '/internal/billing-operations/' + op.id}],
    ['evidence: pending', {path: '/internal/billing-operations/' + other.id}], ['evidence: unknown', {path: '/internal/billing-operations/ghost'}], ['evidence: id of 129 characters', {path: '/internal/billing-operations/' + 'a'.repeat(129)}], ['evidence: database down', {path: '/internal/billing-operations/' + op.id, world: {down: true}}]])
    await step(inst, 'bill', label, {path: '/internal/billing-operations/x-1', headers: svc(TOKENS.evidence), ...spec});
}

// 9. startup refusals of createCoreApp, one fault at a time.
function startup() {
  const attempt = (label, extra, config = {}) => {
    useEnv({...ENV.legacy, ...ENV.runtime, ...extra});
    let outcome = 'created';
    try { const app = createCoreApp(makeDb(makeWorld(), []), config); app.locals.runtime?.close(); } catch (error) { outcome = String(error.message); }
    record('cfg', 'cfg ' + label, outcome);
  };
  const credentials = {CORE_DIRECTORY_TOKEN: TOKENS.directory, CORE_BILLING_EVIDENCE_TOKEN: TOKENS.evidence, CLINIC_BILLING_TOKEN: TOKENS.billing, CORE_NOTIFICATION_SEND_TOKEN: TOKENS.notification};
  const required = {PHASE2_RUNTIME_REQUIRED: '1', ...ENV.rsa, ...credentials}, urls = {clinicUrl: 'http://127.0.0.1:9', notificationUrl: 'http://127.0.0.1:9'};
  const split = {...urls, clinicToken: TOKENS.billing, notificationToken: TOKENS.notification, directoryToken: TOKENS.directory, evidenceToken: TOKENS.evidence}, withoutRsa = {...ENV.rsa, JWT_PRIVATE_KEY: ''};
  attempt('required runtime, complete', required, split);
  attempt('required runtime without the RSA signing key', {...required, JWT_PRIVATE_KEY: undefined, JWT_KEY_ID: undefined}, split);
  attempt('required runtime with two equal credentials', {...required, CORE_DIRECTORY_TOKEN: TOKENS.evidence}, split);
  for (const name of Object.keys(credentials)) attempt(`required runtime without ${name}`, {...required, [name]: undefined}, split);
  attempt('required runtime without the Clinic URL', required, {...split, clinicUrl: undefined});
  attempt('required runtime without the Notification URL', required, {...split, notificationUrl: undefined});
  attempt('required runtime without OBSERVABILITY_TOKEN', {...required, OBSERVABILITY_TOKEN: undefined}, split);
  attempt('a Clinic URL without RSA keys', {}, {...split, notificationUrl: undefined, notificationToken: undefined});
  attempt('a Clinic URL with a short token', ENV.rsa, {clinicUrl: urls.clinicUrl, clinicToken: 'short'});
  attempt('a Clinic URL with a token of 513 characters', ENV.rsa, {clinicUrl: urls.clinicUrl, clinicToken: 'c'.repeat(513)});
  attempt('a Clinic URL with a path', ENV.rsa, {clinicUrl: 'http://127.0.0.1:9/x', clinicToken: TOKENS.billing});
  attempt('a Clinic URL that is not a URL', ENV.rsa, {clinicUrl: 'nope', clinicToken: TOKENS.billing});
  attempt('a Notification URL without RSA keys', {}, {notificationUrl: urls.notificationUrl, notificationToken: TOKENS.notification});
  attempt('a Notification URL with a short token', ENV.rsa, {notificationUrl: urls.notificationUrl, notificationToken: 'short'});
  attempt('a Notification URL with credentials', ENV.rsa, {notificationUrl: 'http://user:pw@127.0.0.1:9', notificationToken: TOKENS.notification});
  attempt('a Notification URL that is not a URL', ENV.rsa, {notificationUrl: 'nope', notificationToken: TOKENS.notification});
  attempt('RSA keys without the issuer', {...ENV.rsa, JWT_ISSUER: undefined}, {});
  attempt('RSA private key only', {JWT_PRIVATE_KEY: ENV.rsa.JWT_PRIVATE_KEY}, {});
  attempt('RSA keys without a private key', withoutRsa, {});
  attempt('runtime on, no limiter secret', {RATE_LIMIT_KEY_SECRET: undefined}, {});
  attempt('runtime on, outbox limits inverted', {OUTBOX_SOFT_LIMIT: '50', OUTBOX_HARD_LIMIT: '10'}, {});
  attempt('runtime on, invalid instance id', {SERVICE_INSTANCE_ID: 'bad id!'}, {});
  attempt('no runtime, no services', {REDIS_URL: undefined}, {});
}

// 10. AppointmentInvoiceBilling on an in-memory double (the saga). The clock is frozen so every date is exact.
const AT = Date.parse('2030-06-01T00:00:00.000Z');
const actorOf = (role, sub = role + '-1') => ({sub, role});
function sagaRig({remote = {}, ops = [], invoices = [], users = {}, world = makeWorld({verbose: true})} = {}) {
  const log = [], db = makeDb(world, log);
  for (const [id, row] of Object.entries(users)) world.users.set(id, row);
  for (const op of ops) world.ops.set(op.id, op);
  for (const invoice of invoices) world.invoices.push(invoice);
  const note = text => log.push({remote: text});
  const double = {
    source: async (id, actor) => { note('source ' + id); return remote.source ? remote.source(id, actor, world) : snapshotOf(id); },
    prepare: async (op, actor) => { note('prepare ' + op.id + ' revision ' + op.expectedRevision); return remote.prepare ? remote.prepare(op, actor, world) : snapshotOf(op.appointmentId, {revision: op.expectedRevision}); },
    finalize: async op => { note('finalize ' + op.id + ' ' + op.state); if (remote.finalize) await remote.finalize(op, world); },
  };
  return {world, log, db, remote: double, billing: new AppointmentInvoiceBilling(db, double)};
}
const sagaOp = (id, extra = {}) => ({id, actorId: 'staff-1', actorRole: 'staff', operationType: 'invoice.create', idempotencyKey: 'k-' + id, requestHash: 'hash-' + id, appointmentId: 'appt-' + id, expectedRevision: 3, payload: {relatedId: 'appt-' + id, subtotal: 150000, taxAmount: 0, discountAmount: 0, notes: null}, state: 'PREPARING', invoiceId: null, snapshot: null, errorCode: null, errorStatus: null, createdAt: new Date(AT), updatedAt: new Date(AT), terminalAt: null, finalizedAt: null, attempts: 0, nextAttemptAt: new Date(AT), leaseOwner: null, leaseUntil: null, ...extra});
const sagaInvoice = (extra = {}) => ({id: 'inv-old', invoiceCode: 'INV-old', type: 'appointment', ownerId: 'owner-1', petId: 'pet-1', appointmentId: 'appt-co', subtotal: 250000, totalAmount: 250000, taxAmount: 0, discountAmount: 0, notes: null, items: [], sourceSnapshot: snapshotOf('appt-co', {type: 'spa_bath'}), ...extra});
const worldState = world => ({
  ops: [...world.ops.values()].map(o => ({id: o.id, state: o.state, invoiceId: o.invoiceId, errorStatus: o.errorStatus, errorCode: o.errorCode, expectedRevision: o.expectedRevision, attempts: o.attempts, leaseOwner: o.leaseOwner, leaseUntil: o.leaseUntil?.toISOString() ?? null, nextAttemptAt: o.nextAttemptAt.toISOString(), finalizedAt: o.finalizedAt?.toISOString() ?? null, terminalAt: o.terminalAt?.toISOString() ?? null})),
  invoices: world.invoices.map(i => ({id: i.id, appointmentId: i.appointmentId, totalAmount: i.totalAmount})),
  events: world.events.map(e => e.envelope.eventType),
});
async function outcome(rig, work) {
  let result;
  try { result = {value: await work(rig)}; } catch (error) { result = {rejected: {name: error?.constructor?.name, status: error?.status, code: error?.code, message: error?.message}}; }
  const scrub = scrubber({nowIsDynamic: false});
  return scrub({...result, calls: rig.log, state: worldState(rig.world)});
}
const opView = op => op && ({id: op.id, state: op.state, invoiceId: op.invoiceId, errorStatus: op.errorStatus, errorCode: op.errorCode});
async function saga() {
  mock.timers.enable({apis: ['Date'], now: AT});
  try {
    const check = async (label, rig, work) => record('saga', 'saga ' + label, await outcome(rig, async r => { const out = await work(r); return out && typeof out === 'object' && 'state' in out ? opView(out) : out; }));
    // request hash: the order of keys in fees() decides it
    const payloads = [['subtotal', actorOf('staff'), {type: 'appointment', relatedId: 'appt-1', subtotal: 150000}, false], ['lines', actorOf('admin'), {type: 'appointment', relatedId: 'appt-2', items: [{description: ' Vaccine ', quantity: 2, unitPrice: 50000}, {description: 'Exam', quantity: 1, unitPrice: 20000}]}, false],
      ['everything', actorOf('staff'), {type: 'appointment', relatedId: ' appt-3 ', subtotal: 10, taxAmount: 5, discountAmount: 2, notes: ' note ', expectedRevision: 4}, false], ['checkout', actorOf('owner'), {type: 'appointment', relatedId: 'appt-4'}, true]];
    for (const [label, actor, input, self] of payloads) {
      const rig = sagaRig();
      await check('begin ' + label, rig, async r => { const op = await r.billing.begin(actor, input, 'key-1', self); const again = await r.billing.begin(actor, input, 'key-1', self); return {sameOperation: again.id === op.id, operationType: op.operationType, requestHash: op.requestHash, payload: op.payload, expectedRevision: op.expectedRevision}; });
    }
    const begin = (label, actor, input, key, self = false, users) => check('begin ' + label, sagaRig({users}), r => r.billing.begin(actor, input, key, self));
    const rig = sagaRig();
    await check('begin other charges after a first request', rig, async r => { await r.billing.begin(actorOf('staff'), {type: 'appointment', relatedId: 'appt-1', subtotal: 150000}, 'key-1'); return r.billing.begin(actorOf('staff'), {type: 'appointment', relatedId: 'appt-1', subtotal: 1}, 'key-1'); });
    await check('begin a second key on a pending appointment', sagaRig(), async r => { await r.billing.begin(actorOf('staff'), {type: 'appointment', relatedId: 'appt-1', subtotal: 1}, 'key-1'); return r.billing.begin(actorOf('staff'), {type: 'appointment', relatedId: 'appt-1', subtotal: 1}, 'key-2'); });
    const bad = {type: 'nope'};
    await begin('order 1: account missing', actorOf('staff', 'ghost-1'), bad, ' bad');
    await begin('order 2: role changed', actorOf('admin', 'swapped-admin-1'), bad, ' bad');
    await begin('order 3: permission before key and fees', actorOf('owner'), bad, ' bad');
    await begin('order 4: self-service permission', actorOf('staff'), bad, ' bad', true);
    await begin('order 5: key before fees', actorOf('staff'), bad, ' bad');
    await begin('order 6: fees', actorOf('staff'), bad, 'key-1');
    for (const [label, key] of [['no key', undefined], ['empty key', ' '], ['key with spaces', ' k '], ['key of 129 characters', 'k'.repeat(129)], ['key of 128 characters', 'k'.repeat(128)]]) await begin(label, actorOf('staff'), {type: 'appointment', relatedId: 'a', subtotal: 1}, key);
    for (const [label, input, self] of [['relatedId empty', {type: 'appointment', relatedId: ' '}, false], ['relatedId of 129 characters', {type: 'appointment', relatedId: 'r'.repeat(129)}, false], ['array', [], false], ['self-service with extra keys', {type: 'appointment', relatedId: 'a', subtotal: 1}, true],
      ['notes a number', {type: 'appointment', relatedId: 'a', subtotal: 1, notes: 5}, false], ['notes of 2001 characters', {type: 'appointment', relatedId: 'a', subtotal: 1, notes: 'n'.repeat(2001)}, false], ['expectedRevision negative', {type: 'appointment', relatedId: 'a', subtotal: 1, expectedRevision: -1}, false],
      ['expectedRevision a fraction', {type: 'appointment', relatedId: 'a', subtotal: 1, expectedRevision: 1.5}, false], ['no subtotal and no items', {type: 'appointment', relatedId: 'a'}, false], ['items not an array', {type: 'appointment', relatedId: 'a', items: 'x'}, false],
      ['tax a string', {type: 'appointment', relatedId: 'a', subtotal: 1, taxAmount: '1'}, false], ['discount negative', {type: 'appointment', relatedId: 'a', subtotal: 1, discountAmount: -1}, false]])
      await begin('fees: ' + label, actorOf(self ? 'owner' : 'staff'), input, 'key-1', self);

    // terminal: the transaction of a commit, an abort, a repeat and a checkout over an existing invoice
    const terminal = (label, setup, work) => check('terminal ' + label, sagaRig(setup), work);
    const snap = (extra) => snapshotOf('appt-t', extra);
    const op = (extra) => sagaOp('t', {appointmentId: 'appt-t', ...extra});
    await terminal('commit', {ops: [op()]}, r => r.billing.terminal('t', 'commit', snap()));
    await terminal('commit with lines, tax and discount', {ops: [op({payload: {relatedId: 'appt-t', items: [{description: 'A', quantity: 2, unitPrice: 100, amount: 200}], taxAmount: 20, discountAmount: 10, notes: 'n'}})]}, r => r.billing.terminal('t', 'commit', snap()));
    await terminal('commit, then the same again', {ops: [op()]}, async r => { await r.billing.terminal('t', 'commit', snap()); r.log.push({second: 'call'}); return r.billing.terminal('t', 'commit', snap()); });
    await terminal('abort', {ops: [op()]}, r => r.billing.terminal('t', 'abort', undefined, {status: 409, code: 'Why'}));
    await terminal('abort with a snapshot', {ops: [op()]}, r => r.billing.terminal('t', 'abort', snap(), {status: 404, code: 'Gone'}));
    await terminal('abort after commit changes nothing', {ops: [op({state: 'COMMITTED', invoiceId: 'inv-x'})]}, r => r.billing.terminal('t', 'abort'));
    await terminal('commit without a snapshot', {ops: [op()]}, r => r.billing.terminal('t', 'commit'));
    await terminal('commit with another appointment', {ops: [op()]}, r => r.billing.terminal('t', 'commit', snapshotOf('appt-other', {revision: 3})));
    await terminal('commit with another revision', {ops: [op()]}, r => r.billing.terminal('t', 'commit', snap({revision: 4})));
    await terminal('commit with no expected revision', {ops: [op({expectedRevision: null})]}, r => r.billing.terminal('t', 'commit', snap()));
    await terminal('unknown operation', {}, r => r.billing.terminal('ghost', 'commit', snap()));
    await terminal('afterLock runs after the lock and before the read', {ops: [op()]}, r => r.billing.terminal('t', 'commit', snap(), undefined, undefined, async () => { r.log.push({afterLock: true}); }));
    await terminal('afterLock fails', {ops: [op()]}, r => r.billing.terminal('t', 'commit', snap(), undefined, undefined, async () => { throw new Error('after lock'); }));
    await terminal('fault after the event rolls everything back', {ops: [op()]}, r => r.billing.terminal('t', 'commit', snap(), undefined, () => { throw new Error('fault'); }));
    await terminal('fault after an abort rolls everything back', {ops: [op()]}, r => r.billing.terminal('t', 'abort', undefined, {status: 409, code: 'x'}, () => { throw new Error('fault'); }));
    await terminal('invoice already exists (P2002)', {ops: [op()], invoices: [sagaInvoice({appointmentId: 'appt-t'})]}, r => r.billing.terminal('t', 'commit', snap()));
    const checkout = extra => op({operationType: 'invoice.checkout', actorId: 'owner-1', actorRole: 'owner', appointmentId: 'appt-co', payload: {relatedId: 'appt-co', taxAmount: 0, discountAmount: 0, notes: null}, ...extra});
    await terminal('checkout, new invoice at the fixed rate', {ops: [checkout()]}, r => r.billing.terminal('t', 'commit', snapshotOf('appt-co', {type: 'spa_bath'})));
    await terminal('checkout, a service without a fixed rate', {ops: [checkout()]}, r => r.billing.terminal('t', 'commit', snapshotOf('appt-co')));
    await terminal('checkout over an existing invoice: no event, finalized at once', {ops: [checkout()], invoices: [sagaInvoice()]}, r => r.billing.terminal('t', 'commit', snapshotOf('appt-co', {type: 'spa_bath'})));
    await terminal('checkout over an invoice of another owner', {ops: [checkout()], invoices: [sagaInvoice({ownerId: 'owner-2'})]}, r => r.billing.terminal('t', 'commit', snapshotOf('appt-co', {type: 'spa_bath'})));
    await terminal('checkout abort over an existing invoice', {ops: [checkout()], invoices: [sagaInvoice()]}, r => r.billing.terminal('t', 'abort', undefined, {status: 409, code: 'x'}));

    // resume
    const resume = (label, setup, id = 'r') => check('resume ' + label, sagaRig(setup), r => r.billing.resume(id));
    const rop = extra => sagaOp('r', {appointmentId: 'appt-r', ...extra});
    await resume('commits when the revision is known', {ops: [rop()]});
    await resume('asks Clinic for the revision first', {ops: [rop({expectedRevision: null})]});
    await resume('an operation that is already terminal', {ops: [rop({state: 'ABORTED', errorStatus: 409, errorCode: 'x'})]});
    await resume('unknown operation', {});
    await resume('the id of 129 characters', {}, 'r'.repeat(129));
    await resume('the operation ends while the revision is read', {ops: [rop({expectedRevision: null})], remote: {source: async (id, actor, world) => { world.ops.get('r').state = 'ABORTED'; return snapshotOf(id); }}});
    await resume('actor account gone', {ops: [rop({actorId: 'ghost-1'})]});
    await resume('Clinic rejects the source with 404', {ops: [rop({expectedRevision: null})], remote: {source: async () => { throw new BusinessError(404, 'Clinic rejected the billing source.'); }}});
    await resume('Clinic rejects the reservation with 409', {ops: [rop()], remote: {prepare: async () => { throw new BusinessError(409, 'Clinic rejected the billing source.'); }}});
    await resume('Clinic unavailable (503) keeps the operation pending', {ops: [rop()], remote: {prepare: async () => { throw new BusinessError(503, 'Clinic billing temporarily unavailable.'); }}});
    await resume('a network error keeps the operation pending', {ops: [rop()], remote: {prepare: async () => { throw new TypeError('fetch failed'); }}});
    await resume('the reservation revision differs', {ops: [rop()], remote: {prepare: async (op) => snapshotOf(op.appointmentId, {revision: 9})}});
    await resume('the pet is unknown', {ops: [rop()], remote: {prepare: async op => snapshotOf(op.appointmentId, {revision: 3, petId: 'ghost'})}});
    await resume('the pet belongs to another owner', {ops: [rop()], remote: {prepare: async op => snapshotOf(op.appointmentId, {revision: 3, ownerId: 'owner-2'})}});
    await resume('the snapshot owner is not an owner account', {ops: [rop()], remote: {prepare: async op => snapshotOf(op.appointmentId, {revision: 3, ownerId: 'staff-9', petId: 'pet-3'})}});
    await resume('an owner checks out another owner\'s appointment', {ops: [rop({operationType: 'invoice.checkout', actorId: 'owner-2', actorRole: 'owner', payload: {relatedId: 'appt-r', taxAmount: 0, discountAmount: 0, notes: null}})], remote: {prepare: async op => snapshotOf(op.appointmentId, {revision: 3, type: 'spa_bath'})}});
    await resume('an invoice appears meanwhile (P2002 aborts)', {ops: [rop()], remote: {prepare: async (op, actor, world) => { world.invoices.push(sagaInvoice({appointmentId: 'appt-r', id: 'inv-race'})); return snapshotOf(op.appointmentId, {revision: 3}); }}});
    await resume('checkout over an existing invoice commits with its snapshot', {ops: [rop({operationType: 'invoice.checkout', actorId: 'owner-1', actorRole: 'owner', appointmentId: 'appt-co', expectedRevision: null, payload: {relatedId: 'appt-co', taxAmount: 0, discountAmount: 0, notes: null}})], invoices: [sagaInvoice()]});
    await resume('checkout over an invoice of another owner aborts', {ops: [rop({operationType: 'invoice.checkout', actorId: 'owner-1', actorRole: 'owner', appointmentId: 'appt-co'})], invoices: [sagaInvoice({ownerId: 'owner-2'})]});
    await resume('checkout over a historical invoice without a snapshot stays pending', {ops: [rop({operationType: 'invoice.checkout', actorId: 'owner-1', actorRole: 'owner', appointmentId: 'appt-co'})], invoices: [sagaInvoice({sourceSnapshot: null})]});
    await resume('checkout over an existing invoice with another revision: the error leaves resume', {ops: [rop({operationType: 'invoice.checkout', actorId: 'owner-1', actorRole: 'owner', appointmentId: 'appt-co', expectedRevision: 3})], invoices: [sagaInvoice({sourceSnapshot: snapshotOf('appt-co', {revision: 9})})]});
    await resume('the abort itself fails: the error leaves resume', {ops: [rop()], remote: {prepare: async () => { throw new BusinessError(404, 'Clinic rejected the billing source.'); }}, world: Object.assign(makeWorld({verbose: true}), {failOn: name => name === 'appointmentBillingOperation.update' ? new Error('update failed') : undefined})});
    await check('result', sagaRig({ops: [rop({state: 'COMMITTED', invoiceId: 'inv-1'}), rop({state: 'ABORTED', errorStatus: 404, errorCode: 'Gone', id: 'a'}), rop({state: 'ABORTED', id: 'b'}), rop({id: 'c'})], invoices: [sagaInvoice({id: 'inv-1', items: [{id: 'l1', description: 'X', quantity: 1, unitPrice: '1000', amount: '1000'}], subtotal: '1000', totalAmount: '1000'})]}),
      async r => { const out = []; for (const id of ['r', 'a', 'b', 'c']) out.push(await r.billing.result(await r.billing.read(id))); return out; });

    // reconcileOnce
    for (const limit of [0, 33, 1.5, 'x']) await check('reconcile limit ' + limit, sagaRig(), r => r.billing.reconcileOnce('worker-1', limit));
    const pending = (id, extra = {}) => sagaOp(id, extra);
    const down = {source: async () => { throw new TypeError('fetch failed'); }};
    await check('reconcile backoff by attempts', sagaRig({ops: [0, 1, 2, 3, 5, 6, 7, 8, 12].map(n => pending('b' + n, {attempts: n, expectedRevision: null, createdAt: new Date(AT + n)})), remote: down}), async r => ({claimed: await r.billing.reconcileOnce('worker-1', 32), attempts: Object.fromEntries([...r.world.ops.values()].map(o => [o.id, [o.attempts, o.nextAttemptAt.getTime() - AT]]))}));
    await check('reconcile picks only due, unleased, unfinalized operations in order, up to the limit', sagaRig({remote: down, ops: [
      pending('due-2', {expectedRevision: null, createdAt: new Date(AT + 2)}), pending('due-1', {expectedRevision: null, createdAt: new Date(AT + 1)}), pending('later', {expectedRevision: null, nextAttemptAt: new Date(AT + 5000)}),
      pending('leased', {expectedRevision: null, leaseUntil: new Date(AT + 5000), leaseOwner: 'other'}), pending('lease-over', {expectedRevision: null, leaseUntil: new Date(AT - 1), leaseOwner: 'other', createdAt: new Date(AT + 3)}),
      pending('finalized', {state: 'COMMITTED', finalizedAt: new Date(AT), invoiceId: 'i'})]}), async r => ({claimed: await r.billing.reconcileOnce('worker-1', 2), left: Object.fromEntries([...r.world.ops.values()].map(o => [o.id, o.attempts]))}));
    await check('reconcile only the named operation', sagaRig({remote: down, ops: [pending('one', {expectedRevision: null}), pending('two', {expectedRevision: null})]}), async r => ({claimed: await r.billing.reconcileOnce('worker-1', 8, 'two')}));
    await check('reconcile a pending operation that commits, then finalizes', sagaRig({ops: [pending('c1')]}), async r => ({claimed: await r.billing.reconcileOnce('worker-1')}));
    await check('reconcile an operation that aborts, then finalizes (release)', sagaRig({ops: [pending('c2')], remote: {prepare: async () => { throw new BusinessError(409, 'Clinic rejected the billing source.'); }}}), async r => ({claimed: await r.billing.reconcileOnce('worker-1')}));
    await check('reconcile an operation that is terminal but not finalized', sagaRig({ops: [pending('c3', {state: 'COMMITTED', invoiceId: 'i'})]}), async r => ({claimed: await r.billing.reconcileOnce('worker-1')}));
    await check('reconcile finalize fails: no finalizedAt, the lease is released with a backoff', sagaRig({ops: [pending('c4', {state: 'ABORTED'})], remote: {finalize: async () => { throw new Error('clinic down'); }}}), async r => ({claimed: await r.billing.reconcileOnce('worker-1')}));
    await check('reconcile the lease is lost to another worker during finalize', sagaRig({ops: [pending('c5', {state: 'ABORTED'})], remote: {finalize: async (op, world) => { world.ops.get(op.id).leaseOwner = 'worker-2'; }}}), async r => ({claimed: await r.billing.reconcileOnce('worker-1')}));
    await check('reconcile the read after the work fails: the error leaves the loop', sagaRig({ops: [pending('c6', {state: 'ABORTED'}), pending('c7', {state: 'ABORTED', createdAt: new Date(AT + 1)})], remote: {finalize: async (op, world) => { world.ops.delete(op.id); }}}), async r => ({claimed: await r.billing.reconcileOnce('worker-1')}));
  } finally { mock.timers.reset(); }
}

// ---- run everything, then compare ------------------------------------------------------------------------
for (const cfg of CONFIGS) {
  let inst = await boot(cfg);
  try { await sweep(inst); } finally { await inst.close(); }
  inst = await boot(cfg);
  try {
    await middleware(inst); await accounts(inst); await errors(inst); await health(inst);
    await directory(inst); await authorizeSend(inst); await billing(inst);
  } finally { await inst.close(); }
}
startup();
await saga();

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')).stable;
const plain = value => JSON.parse(JSON.stringify(value));
const GROUPS = {sweep: 'every OpenAPI operation, three configurations, no token and admin', mw: 'middleware order: bodies, CORS, docs, 404, bootstrap', acct: 'currentAccount branches', err: 'error handlers', health: 'health and metrics',
  cfg: 'startup refusals', dir: '/internal/directory', send: '/internal/notifications/authorize-send', bill: 'appointment billing over HTTP and the evidence route', saga: 'AppointmentInvoiceBilling on an in-memory double'};
for (const [group, label] of Object.entries(GROUPS)) test(`${group}: ${label}`, () => {
  const names = Object.keys(observed).filter(name => groupOf[name] === group);
  assert.ok(names.length > 0, group + ' has cases');
  for (const name of names) assert.deepEqual(plain(observed[name]), golden[name], name);
  assert.deepEqual(Object.keys(golden).filter(name => name.startsWith(group + ' ') && !(name in observed)), [], 'cases in the golden file that no longer run');
});
test('the golden file holds exactly the cases that ran', () => assert.deepEqual(Object.keys(golden).sort(), Object.keys(observed).sort()));
test('the sweep covers 75 operations in 3 configurations without a token and as admin', () => assert.equal(Object.keys(observed).filter(name => groupOf[name] === 'sweep').length, 75 * 3 * 2));
