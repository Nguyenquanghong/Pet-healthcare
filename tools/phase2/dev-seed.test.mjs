import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from './dev-seed.mjs';

// Every refusal below happens before a database client exists, so these need no database.
const refuses = async (env, args, pattern) => {
  const saved = { ...process.env };
  for (const key of ['NODE_ENV', 'DEV_SEED_DATABASE_URL', 'DEV_SEED_API_URL']) delete process.env[key];
  Object.assign(process.env, env);
  try { await assert.rejects(() => main(args), pattern); } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
};
const local = 'postgresql://u:p@127.0.0.1:5432/db?schema=public';

test('production is refused even with a local database', () => refuses({ NODE_ENV: 'production', DEV_SEED_DATABASE_URL: local }, [], /NODE_ENV=production/));
test('a database URL is required, so no default target can be hit by accident', () => refuses({}, [], /DEV_SEED_DATABASE_URL/));
test('a database or API that is not on this machine is refused', async () => {
  await refuses({ DEV_SEED_DATABASE_URL: 'postgresql://u:p@db.internal:5432/db' }, [], /must point at this machine/);
  await refuses({ DEV_SEED_DATABASE_URL: local, DEV_SEED_API_URL: 'https://pet.example.com' }, ['--mark'], /must point at this machine/);
});
test('an unknown argument is refused', () => refuses({ DEV_SEED_DATABASE_URL: local }, ['--force'], /Usage/));
