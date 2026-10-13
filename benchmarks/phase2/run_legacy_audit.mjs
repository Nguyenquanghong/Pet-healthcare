// Run the pre-split integration scripts on a newly created, isolated test DB.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertTestProject } from '../../tools/phase2/test-project.mjs';

assertTestProject();
const run = randomUUID(), suffix = run.replaceAll('-', '').slice(0, 12);
const database = `audit_${suffix}_test`, role = `audit_${suffix}`, password = 'audit_fixture_only';
const directory = resolve('test-results/phase2/legacy-audit-' + run);
mkdirSync(directory, { recursive: true });
const sql = `CREATE ROLE ${role} LOGIN PASSWORD '${password}';
CREATE DATABASE ${database} OWNER ${role};
REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${database} TO ${role};
`;
execFileSync('docker', ['compose','-f','deploy/phase2/compose.test.yml','exec','-T','postgres','psql','-X','-U','p2_bootstrap','-d','postgres','-v','ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe','pipe','pipe'] });
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(JWT_|VNPAY_|BANK_TRANSFER_|PG_TEST_|PHASE2_RUNTIME|REDIS_URL|CORE_.*TOKEN|CLINIC_.*TOKEN|NOTIFICATION_.*TOKEN)/.test(name)) delete env[name];
env.PG_TEST_DATABASE_URL = env.DATABASE_URL = `postgresql://${role}:${password}@127.0.0.1:55432/${database}`;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
try {
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
  if (identity.db !== database || identity.role !== role) throw new Error('AUDIT_DB_IDENTITY_MISMATCH');
} finally { await db.$disconnect(); }
const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy','--schema','backend/prisma/schema.prisma'], { env, encoding:'utf8', timeout:60000 });
writeFileSync(resolve(directory, 'migration.log'), (migration.stdout ?? '') + (migration.stderr ?? ''));
if (migration.status !== 0) throw new Error('AUDIT_DB_MIGRATION_FAILED');
try {
  await db.$executeRawUnsafe('CREATE TABLE audit_fixture_marker (run_id text PRIMARY KEY)');
  await db.$executeRaw`INSERT INTO audit_fixture_marker VALUES (${run})`;
} finally { await db.$disconnect(); }
const files = ['postgres','fix-postgres','invoices','payments','bank-transfer','vietqr','booking-lifecycle','hotel-booking-idempotency','admin-creation','owner-activation','phase1-security','pagination'];
const results = [];
for (const name of files) {
  const started = Date.now();
  const child = spawnSync(process.execPath, [`tests/${name}.integration.mjs`], { cwd:'backend', env, encoding:'utf8', timeout:90000 });
  writeFileSync(resolve(directory, name + '.log'), (child.stdout ?? '') + (child.stderr ?? ''));
  const result = { suite: name, exitCode: child.status, signal: child.signal, errorCode: child.error?.code ?? null, elapsedMs: Date.now() - started };
  results.push(result); process.stdout.write(JSON.stringify(result) + '\n');
}
const report = { run, database, role, project:'pet-phase2-p1-test', results, passed:results.filter(r=>r.exitCode===0).length,
  failed:results.filter(r=>r.exitCode!==0).length, databaseRetained:true, liveDatabaseTouched:false };
writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify({ report:resolve(directory,'report.json'), passed:report.passed, failed:report.failed }) + '\n');
process.exitCode = report.failed ? 1 : 0;
