import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv as parse } from 'node:util';

export function prepareNotifications(path) {
  const source = readFileSync(path, 'utf8'), env = parse(source);
  const names = ['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID',
    'CORE_NOTIFICATION_SEND_TOKEN','NOTIFICATION_POSTGRES_PASSWORD','BROKER_PASSWORD'];
  const present = names.filter(name => env[name]);
  if (present.length === names.length) return false; // Never rotate keys on rerun.
  if (present.length) throw new Error('PARTIAL_NOTIFICATION_CONFIGURATION: complete or review existing values; nothing was changed.');
  // Even a blank declaration would create ambiguous duplicate keys on append.
  if (names.some(name => Object.hasOwn(env, name))) throw new Error('EXISTING_NOTIFICATION_KEYS: remove blank declarations before preparation; nothing was changed.');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const values = { JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: 'nipopeto-local-core', JWT_AUDIENCE: 'nipopeto-local', JWT_KEY_ID: 'local-v1',
    CORE_NOTIFICATION_SEND_TOKEN: randomBytes(32).toString('hex'),
    NOTIFICATION_POSTGRES_PASSWORD: randomBytes(32).toString('hex'), BROKER_PASSWORD: randomBytes(32).toString('hex') };
  // Compose and dotenv both support single-quoted multiline PEM values.
  const addition = '\n# Local Notification configuration; generated once, keep private.\n'
    + Object.entries(values).map(([name,value]) => `${name}='${value}'`).join('\n') + '\n';
  appendFileSync(path, addition, { encoding: 'utf8' });
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node tools/docker/prepare-notifications.mjs [private-env-file]');
    console.log(prepareNotifications(resolve(process.argv[2] || '.env.docker'))
      ? 'Notification configuration appended. Existing database credentials preserved. Sign in again after deployment.'
      : 'Notification configuration already present; no values changed.');
  } catch (error) { console.error(error.code === 'ENOENT' ? 'Private env file missing. Copy .env.docker.example and configure the Core database first.' : error.message); process.exitCode = 1; }
}
