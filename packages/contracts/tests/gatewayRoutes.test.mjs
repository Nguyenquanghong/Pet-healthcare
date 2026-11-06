import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRoutes, gatewayTopologies, routeOwner, servicePrefixes } from '../dist/index.js';

test('every prefix and its sub-paths belong to the declared service', () => {
  for (const { prefix, service } of gatewayRoutes) {
    assert.equal(routeOwner(prefix), service, prefix);
    assert.equal(routeOwner(prefix + '/'), service, prefix + '/');
    assert.equal(routeOwner(prefix + '/x'), service, prefix + '/x');
    assert.equal(routeOwner(prefix + '/x/y'), service, prefix + '/x/y');
  }
});

test('a path is owned only on a segment boundary', () => {
  for (const { prefix } of gatewayRoutes) {
    assert.equal(routeOwner(prefix + 'x'), 'core', prefix + 'x');
    assert.equal(routeOwner(prefix + '-x'), 'core', prefix + '-x');
  }
  assert.equal(routeOwner('/api/appointmentsx'), 'core');
  assert.equal(routeOwner('/api/dashboard'), 'core');
  assert.equal(routeOwner('/api/dashboard/clinicx'), 'core');
});

test('matching is case-sensitive', () => {
  assert.equal(routeOwner('/api/Appointments'), 'core');
  assert.equal(routeOwner('/api/APPOINTMENTS/x'), 'core');
  assert.equal(routeOwner('/api/Notifications'), 'core');
  assert.equal(routeOwner('/API/appointments'), 'core');
});

test('every other /api path is Core', () => {
  for (const path of [
    '/api/pets',
    '/api/auth/login',
    '/api/dashboard/admin',
    '/api',
    '/',
    '/internal/directory/authorize',
  ])
    assert.equal(routeOwner(path), 'core', path);
});

test('servicePrefixes lists the prefixes in declaration order', () => {
  assert.deepEqual(servicePrefixes('clinic'), ['/api/appointments', '/api/medical-records', '/api/dashboard/clinic']);
  assert.deepEqual(servicePrefixes('notification'), ['/api/notifications']);
});

test('prefixes are unique, none contains another, and both topologies are named', () => {
  const prefixes = gatewayRoutes.map(r => r.prefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
  for (const a of prefixes)
    for (const b of prefixes) if (a !== b) assert.ok(!b.startsWith(a + '/'), `${a} covers ${b}`);
  assert.deepEqual(Object.keys(gatewayTopologies).sort(), ['core-ingress', 'direct']);
});
