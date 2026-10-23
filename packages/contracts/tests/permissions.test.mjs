import test from 'node:test';
import assert from 'node:assert/strict';
import { allows, deniedMessage, permissionMatrix, permissions, permissionsFor, roles } from '../dist/index.js';

test('AQ-05 matrix: known roles only, dotted names, a denial message, no permission for nobody', () => {
  assert.deepEqual([...roles], ['owner', 'doctor', 'staff', 'admin']);
  for (const permission of permissions) {
    const entry = permissionMatrix[permission];
    assert.match(permission, /^[a-z]+(-[a-z]+)*(\.[a-z]+(-[a-z]+)*)+$/);
    assert.ok(entry.roles.length > 0 && entry.roles.every(role => roles.includes(role)), permission);
    assert.equal(new Set(entry.roles).size, entry.roles.length, permission + ' lists a role twice');
    assert.ok(deniedMessage(permission).length > 0);
  }
});

test('AQ-05 decisions of 23/10: staff only reads medical records, doctor only reads billing', () => {
  assert.deepEqual(permissionsFor('staff').includes('medical-record.write'), false);
  assert.deepEqual(permissionsFor('doctor').includes('billing.manage'), false);
  assert.equal(allows('doctor', 'medical-record.write'), true);
  assert.equal(allows('staff', 'billing.manage'), true);
  assert.deepEqual(permissionsFor('admin').filter(p => p !== 'billing.self-service'), permissions.filter(p => p !== 'billing.self-service'));
  assert.deepEqual(permissionsFor('owner'), ['billing.self-service']);
});

test('unknown or missing roles get nothing', () => {
  for (const role of [undefined, null, '', 'Admin', 'root', 0]) {
    assert.deepEqual(permissionsFor(role), []);
    for (const permission of permissions) assert.equal(allows(role, permission), false);
  }
});
