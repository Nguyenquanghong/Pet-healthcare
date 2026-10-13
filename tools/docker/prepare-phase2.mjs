import { randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareNotifications } from './prepare-notifications.mjs';

export const phase2Keys = ['CLINIC_POSTGRES_PASSWORD', 'CORE_DIRECTORY_TOKEN',
  'CORE_BILLING_EVIDENCE_TOKEN', 'CLINIC_BILLING_TOKEN', 'CLINIC_BOOTSTRAP_TOKEN',
  'RATE_LIMIT_KEY_SECRET', 'OBSERVABILITY_TOKEN'];
export function preparePhase2(path) {
  const env = parseEnv(readFileSync(path, 'utf8'));
  const present = phase2Keys.filter(name => Object.hasOwn(env, name));
  if (present.length && (present.length !== phase2Keys.length || present.some(name => !/^[a-f0-9]{64}$/.test(env[name])))) {
    throw new Error('PARTIAL_OR_INVALID_PHASE2_CONFIGURATION: review existing keys; nothing was changed.');
  }
  if (present.length && new Set(phase2Keys.map(name => env[name])).size !== phase2Keys.length) {
    throw new Error('DISTINCT_PHASE2_CREDENTIALS_REQUIRED');
  }
  // Validate the new group before the compatibility helper can append anything.
  const changed = prepareNotifications(path);
  if (present.length) return changed;
  appendFileSync(path, '\n# Strict three-service local configuration; keep private.\n' +
    phase2Keys.map(name => `${name}='${randomBytes(32).toString('hex')}'`).join('\n') + '\n');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node tools/docker/prepare-phase2.mjs [private-env-file]');
    console.log(preparePhase2(resolve(process.argv[2] || '.env.docker'))
      ? 'Phase 2 configuration appended; existing credentials preserved.' : 'Configuration already present; nothing changed.');
  } catch (error) { console.error(error.code === 'ENOENT' ? 'Private env file missing.' : error.message); process.exitCode = 1; }
}
