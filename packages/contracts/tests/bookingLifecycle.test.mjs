import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingLifecycles, bookingStatusLabels, cancelRule, isOccupying, lifecycleGuards, manualTransition, permissions, rescheduleRule, statusLabel, systemTransition, undoRule } from '../dist/index.js';

// P01: the lifecycle table is internally consistent before any service reads it.
for (const [kind, lifecycle] of Object.entries(bookingLifecycles)) {
  test(`${kind} lifecycle: every rule names known statuses, permissions and guards`, () => {
    const { statuses } = lifecycle, known = status => assert.ok(statuses.includes(status), `${kind}: unknown status ${status}`);
    known(lifecycle.initial);
    lifecycle.occupying.forEach(known);
    const rules = [...Object.entries(lifecycle.manual).flatMap(([from, list]) => { known(from); return list; }), ...Object.entries(lifecycle.undo).map(([from, rule]) => { known(from); return rule; })];
    for (const rule of rules) {
      known(rule.to);
      assert.ok(permissions.includes(rule.permission), `${kind}: unknown permission ${rule.permission}`);
      for (const guard of rule.guards) assert.ok(lifecycleGuards.includes(guard), `${kind}: unknown guard ${guard}`);
    }
    for (const step of [lifecycle.cancel, lifecycle.reschedule].filter(Boolean)) { step.from.forEach(known); known(step.to); }
    for (const move of Object.values(lifecycle.system)) { move.from.forEach(known); known(move.to); }
    for (const status of statuses) assert.ok(Object.hasOwn(bookingStatusLabels, status), `${kind}: ${status} has no label`);
  });

  test(`${kind} lifecycle: undo only reverses a manual move, and no move leaves an ended booking`, () => {
    for (const [from, rule] of Object.entries(lifecycle.undo))
      assert.ok(manualTransition(kind, rule.to, from), `${kind}: undo ${from} -> ${rule.to} has no forward move ${rule.to} -> ${from}`);
    const ended = lifecycle.statuses.filter(s => !lifecycle.occupying.includes(s));
    for (const status of ended) assert.equal(Object.hasOwn(lifecycle.manual, status), false, `${kind}: ${status} has manual moves`);
    assert.ok(lifecycle.occupying.includes(lifecycle.initial));
  });
}

test('lookups answer from the table and nothing else', () => {
  assert.deepEqual(manualTransition('appointment', 'confirmed', 'no_show')?.permission, 'booking.manage');
  assert.equal(manualTransition('appointment', 'pending', 'completed'), undefined);
  assert.equal(manualTransition('hotel', 'toString', 'x'), undefined);
  assert.deepEqual(manualTransition('hotel', 'in_stay', 'checked_out')?.guards, ['final-invoice-paid', 'no-medical-record']);
  assert.equal(undoRule('appointment', 'completed')?.permission, 'booking.reopen');
  assert.equal(undoRule('hotel', 'confirmed'), undefined);
  assert.deepEqual(cancelRule('hotel').from, ['pending', 'confirmed']);
  assert.equal(rescheduleRule('hotel'), null);
  assert.deepEqual(systemTransition('appointment', 'medical-completed')?.from, ['checked_in', 'in_progress']);
  assert.equal(isOccupying('appointment', 'completed'), true);
  assert.equal(isOccupying('hotel', 'checked_out'), false);
  assert.equal(statusLabel('no_show'), 'vắng mặt');
  assert.equal(statusLabel('unknown'), 'unknown');
});
