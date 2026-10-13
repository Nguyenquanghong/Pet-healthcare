import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareNotifications } from './prepare-notifications.mjs';
import { preparePhase2, phase2Keys } from './prepare-phase2.mjs';
const file = text => { const p=join(mkdtempSync(join(tmpdir(),'pet-p2-env-')),'.env');writeFileSync(p,text);return p; };
test('fresh and Notification-only upgrades preserve credentials; repeated preparation never rotates',()=>{
  for(const upgrade of [false,true]){
    const p=file('DATABASE_URL=untouched\nPOSTGRES_PASSWORD=untouched\n');
    if(upgrade)prepareNotifications(p);
    const before=readFileSync(p,'utf8');
    assert.equal(preparePhase2(p),true);
    const after=readFileSync(p,'utf8'),env=parseEnv(after);
    assert.ok(after.startsWith(before));
    assert.equal(new Set(phase2Keys.map(k=>env[k])).size,phase2Keys.length);
    assert.equal(preparePhase2(p),false);assert.equal(readFileSync(p,'utf8'),after);
  }
});
test('partial/blank/duplicate configuration is rejected before any append',()=>{
  for(const text of ['CLINIC_BILLING_TOKEN=\n','CLINIC_BILLING_TOKEN=existing\n',phase2Keys.map(k=>`${k}=${'a'.repeat(64)}`).join('\n')]){
    const p=file(text);assert.throws(()=>preparePhase2(p));assert.equal(readFileSync(p,'utf8'),text);
  }
});
