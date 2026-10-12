import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const roots = ['backend', 'services/clinic', 'services/notification', 'packages/contracts', 'packages/messaging','packages/runtime'];
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'generated' ? [] : e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)]); }
function errors(owner, source, file) {
  const found = [];
  for (const m of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])([^'"]+)\1/g)) {
    const specifier = m[2];
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      if (roots.some(r => r !== owner && target.startsWith(resolve(root, r) + '/')) || roots.some(r => r !== owner && target.startsWith(resolve(root, r) + '\\'))) found.push('cross-service import');
    }
    if (/^@nipopeto\/(backend|clinic|notification)/.test(specifier)) found.push('cross-service package');
    if (owner.startsWith('packages/') && /prisma|repository|persistence/.test(specifier)) found.push('shared package persistence');
  }
  if (/\b(p2_(?:core|clinic|notification)_test)\s*\./i.test(source)) found.push('cross-database SQL');
  return found;
}
const violations = [];
for (const owner of roots) for (const file of files(resolve(root, owner, 'src')).filter(p => p.endsWith('.ts'))) violations.push(...errors(owner, readFileSync(file, 'utf8'), file).map(e => `${relative(root, file)}: ${e}`));
assert.ok(errors('services/clinic', 'import x from "../../../backend/src/lib/prisma.js"', resolve(root, 'services/clinic/src/bad.ts')).length);
assert.ok(errors('packages/contracts', 'import x from "@prisma/client"', resolve(root, 'packages/contracts/src/bad.ts')).length);
assert.ok(errors('packages/messaging', 'import x from "@prisma/client"', resolve(root, 'packages/messaging/src/bad.ts')).length);
assert.ok(errors('services/clinic', 'SELECT * FROM p2_core_test.users', resolve(root, 'services/clinic/src/bad.ts')).length);
assert.deepEqual(violations, []);
const outputs = ['backend/prisma/phase2/schema.prisma', 'services/clinic/prisma/schema.prisma', 'services/notification/prisma/schema.prisma'].map(path => resolve(dirname(resolve(root, path)), readFileSync(resolve(root, path), 'utf8').match(/output\s*=\s*"([^"]+)"/)[1]));
assert.equal(new Set(outputs).size, 3);
console.log('Phase2 boundaries PASS: imports, SQL, distinct clients, negative fixtures.');
