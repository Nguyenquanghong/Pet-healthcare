import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const dir = resolve(root, 'phase2-plan/evidence');
mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const status = git('status', '--porcelain=v1');
const changed = status.split('\n').filter(line => line && !line.endsWith('/')).map(line => line.slice(3));
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
// Snapshot before any implementation edits. Reruns never overwrite original evidence.
function save(name, value) {
  try { writeFileSync(resolve(dir, name), value, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
save('local-changes.md', '# Original local changes\n\n```text\n' + status + '\n```\n\n' + changed.map(path => `- \`${path}\`: SHA256 \`${hash(path)}\``).join('\n') + '\n');
save('baseline.md', `# P0 baseline\n\n- Captured: ${new Date().toISOString()} (UTC; local Asia/Ho_Chi_Minh).\n- Branch: ${git('branch', '--show-current')}; HEAD: ${git('rev-parse', 'HEAD')}.\n- Node: ${process.version}; npm: 11.12.1.\n- Original package-lock SHA256: ${hash('package-lock.json')}.\n- No applicable AGENTS.md found in workspace or parent directories.\n- Docker CLI installed; Linux daemon unavailable at first inspection.\n- Baseline command: npm test (build, unit, architecture, OpenAPI); result in test-results.md.\n- No legacy database writes, seed, merge, reset, commit or push.\n`);
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)]); }
const frontend = files(resolve(root, 'frontend/src')).filter(p => /\.[tj]sx?$/.test(p));
const spec = JSON.parse(readFileSync(resolve(root, 'backend/openapi.json'), 'utf8'));
const mounts = { auth: 'auth', public: 'public', bootstrap: 'bootstrap', pets: 'pets', owners: 'owners', appointments: 'appointments', medicalRecords: 'medical-records', hotelBookings: 'hotel-bookings', notifications: 'notifications', invoices: 'invoices', payments: 'payments', lists: '' };
const routes = [];
for (const [file, prefix] of Object.entries(mounts)) {
  const source = readFileSync(resolve(root, `backend/src/routes/${file}.ts`), 'utf8');
  for (const m of source.matchAll(/router\.(get|post|patch|put|delete)\("([^"]+)"/g)) routes.push({ method: m[1], path: ('/' + [prefix, m[2].replace(/^\//, '')].filter(Boolean).join('/')).replace(/\/$/, '').replace(/:([\w]+)/g, '{$1}'), file });
}
const persistence = files(resolve(root, 'backend/src/infrastructure/persistence'));
const tests = files(resolve(root, 'backend/tests'));
const csv = value => '"' + String(value).replaceAll('"', '""') + '"';
const rows = [['method', 'path', 'operationId', 'targetService', 'routeSource', 'queryTransactionSource', 'uiCaller', 'existingTests', 'review']];
for (const [path, methods] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(methods)) {
  const prefix = path.split('/')[1];
  const owner = ['appointments', 'medical-records'].includes(prefix) ? 'Clinic' : prefix === 'notifications' ? 'Notification' : 'Core';
  const route = routes.find(r => r.path === path && r.method === method);
  const term = ({ 'medical-records': 'medical', 'hotel-bookings': 'hotel', 'hotel-care-notes': 'care', auth: 'auth', public: 'rescue' })[prefix] || prefix.replace(/s$/, '');
  const matches = list => list.filter(p => readFileSync(p, 'utf8').toLowerCase().includes(term.toLowerCase())).map(p => relative(root, p).replaceAll('\\', '/')).join(';');
  rows.push([method.toUpperCase(), '/api' + path, op.operationId, owner, route ? `backend/src/routes/${route.file}.ts` : 'backend/src/app.ts', matches(persistence), matches(frontend), matches(tests), 'Source candidate matches; review transaction boundary per transaction-inventory.md']);
}
writeFileSync(resolve(dir, 'api-inventory.csv'), rows.map(row => row.map(csv).join(',')).join('\n') + '\n');
save('transaction-inventory.md', '# Transaction and ownership audit\n\n' + persistence.filter(p => /\$transaction|FOR UPDATE/.test(readFileSync(p, 'utf8'))).map(p => `- \`${relative(root, p).replaceAll('\\', '/')}\`: ` + readFileSync(p, 'utf8').split('\n').map((line,i) => /\$transaction|FOR UPDATE/.test(line) ? `L${i+1} ${line.trim()}` : '').filter(Boolean).join('; ')).join('\n') + '\n\n- Appointment/medical completion + Notification: atomic today; split requires Clinic outbox.\n- Invoice source lock + invoice + Notification: atomic today; appointment path requires reservation; hotel remains Core.\n- Lifecycle checks medical/care/invoice under booking lock: undo must check Clinic reservation under the same appointment lock.\n- Public rescue, hotel, activation, payment use local transactions; Notification producer replacements belong to P2.\n- Lists/bootstrap join legacy domains: read inventory includes lists.ts before write routers; P3/P5 must split queries.\n- Partial appointment slot index excludes cancelled/no_show for all types; invoice appointment/hotel unique constraints remain mandatory.\n- API CSV caller/test columns are source candidates, not proof that every operation is covered.\n');
console.log(`Baseline preserved; ${rows.length - 1} API operations inventoried.`);
