import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const snapshot = readFileSync('phase2-plan/evidence/local-changes.md', 'utf8');
let checked = 0;
for (const m of snapshot.matchAll(/- `([^`]+)`: SHA256 `([a-f0-9]+)`/g)) {
  assert.equal(createHash('sha256').update(readFileSync(m[1])).digest('hex'), m[2], `Original file changed: ${m[1]}`);
  checked++;
}
assert.ok(checked >= 8, 'Must compare actual original files');
console.log(`Original local changes preserved: ${checked} SHA256 checks PASS.`);
