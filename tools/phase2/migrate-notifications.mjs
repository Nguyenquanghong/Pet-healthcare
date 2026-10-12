import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { PrismaClient as CoreClient } from '@prisma/client';
import { PrismaClient as NotificationClient } from '../../services/notification/src/generated/client/index.js';
import { exportNotifications, inspectImport, importNotifications, verifyImport } from './notification-migration.mjs';
import { assertTestProject } from './test-project.mjs';
if (process.env.PHASE2_TEST_CONFIRM !== 'pet-phase2-p1-test') throw new Error('REHEARSAL_CONFIRMATION_REQUIRED');
const [command, file, ...extra] = process.argv.slice(2);
if (!['export', 'dry-run', 'import', 'verify'].includes(command) || !file || extra.length) throw new Error('Usage: migrate-notifications.mjs export|dry-run|import|verify test-results/phase2/<snapshot>.json');
const target = resolve(file), artifactRoot = resolve('test-results/phase2');
if (relative(artifactRoot, target).startsWith('..') || relative(artifactRoot, target) === '' || !target.endsWith('.json')) throw new Error('ARTIFACT_MUST_STAY_IN_IGNORED_REHEARSAL_DIRECTORY');
assertTestProject();
const core = new CoreClient({ datasourceUrl: 'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test' });
const notification = new NotificationClient({ datasourceUrl: 'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof' });
try {
  if (command === 'export') {
    const snapshot = await exportNotifications(core);
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(target, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    process.stdout.write(JSON.stringify({ command, rows: snapshot.rows.length, sha256: snapshot.sha256 }) + '\n');
  } else {
    const snapshot = JSON.parse(readFileSync(target, 'utf8'));
    const report = command === 'dry-run' ? await inspectImport(notification, snapshot) : command === 'import' ? await importNotifications(notification, snapshot) : await verifyImport(notification, snapshot);
    process.stdout.write(JSON.stringify({ command, ...report }) + '\n');
  }
} catch { process.stderr.write('Notification rehearsal failed; inspect source/target safely. No automatic overwrite/reset.\n'); process.exitCode = 1; }
finally { await Promise.all([core.$disconnect(), notification.$disconnect()]); }
