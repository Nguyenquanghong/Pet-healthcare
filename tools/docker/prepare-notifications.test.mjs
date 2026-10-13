import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { parse } from 'dotenv';
import { prepareNotifications } from './prepare-notifications.mjs';
const file = source => {
  const path = join(mkdtempSync(join(tmpdir(), 'pet-a01-')), '.env');
  writeFileSync(path, source); return path;
};
test('prepare preserves existing bytes and credentials, creates matching RSA keys, rerun never rotates', () => {
  const original = "# existing settings\r\nDATABASE_URL='postgresql://original'\r\nPOSTGRES_PASSWORD=untouched\r\n";
  const path = file(original);
  assert.equal(prepareNotifications(path), true);
  const source = readFileSync(path, 'utf8'), env = parse(source);
  assert.ok(source.startsWith(original)); assert.equal(env.POSTGRES_PASSWORD, 'untouched');
  assert.equal(env.DATABASE_URL, 'postgresql://original');
  const privateKey = createPrivateKey(env.JWT_PRIVATE_KEY), publicKey = createPublicKey(env.JWT_PUBLIC_KEY);
  assert.equal(privateKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.deepEqual(createPublicKey(privateKey).export({type:'spki',format:'der'}), publicKey.export({type:'spki',format:'der'}));
  const secrets = ['CORE_NOTIFICATION_SEND_TOKEN','NOTIFICATION_POSTGRES_PASSWORD','BROKER_PASSWORD'].map(k=>env[k]);
  assert.equal(new Set(secrets).size, 3); secrets.forEach(v=>assert.match(v,/^[a-f0-9]{64}$/));
  assert.equal(prepareNotifications(path), false); assert.equal(readFileSync(path,'utf8'), source);
});
test('partial/blank existing configuration is rejected without writing', () => {
  for (const value of ['existing', '']) {
    const source = `JWT_PUBLIC_KEY=${value}\nDATABASE_URL=untouched\n`, path = file(source);
    assert.throws(()=>prepareNotifications(path), /CONFIGURATION|EXISTING_NOTIFICATION_KEYS/);
    assert.equal(readFileSync(path,'utf8'), source);
  }
});
