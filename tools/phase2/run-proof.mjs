import { execFileSync } from 'node:child_process';
import { assertTestProject } from './test-project.mjs';
// Fail closed before constructing clients or applying migrations.
assertTestProject();
const env = { ...process.env, PHASE2_TEST_CONFIRM: 'pet-phase2-p1-test' };
// Migration runner/test imports use explicit fixture URLs, never legacy .env.
const selection = process.argv.slice(2);
if (selection.length > 1 || (selection.length && !['--notification','--notification-runtime','--clinic','--billing','--resilience','--migration'].includes(selection[0]))) throw new Error('Unsupported suite selection');
const suite = selection[0] === '--migration' ? 'tools/phase2/p7-rehearsal.test.mjs' : selection[0] === '--resilience' ? 'tools/phase2/resilience.test.mjs' : selection[0] === '--billing' ? 'tools/phase2/billing.test.mjs' : selection[0] === '--clinic' ? 'tools/phase2/clinic.test.mjs' : selection[0] === '--notification-runtime' ? 'tools/phase2/notification-runtime.test.mjs' : selection[0] === '--notification' ? 'tools/phase2/notification.test.mjs' : 'tools/phase2/proof.test.mjs';
execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', suite], { env, stdio: 'inherit' });
