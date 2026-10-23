import test from 'node:test';
import assert from 'node:assert/strict';

// P01: generated from the lifecycle table. For every (kind, from, to) the real
// Core and Clinic services, over an in-memory transaction, accept exactly what the
// table allows, apply exactly its guards and permissions, and refuse the rest.
// Written to pass on the hand-written services first, so the table is a faithful
// copy of their behaviour before they read from it.
const { allows, roles, bookingLifecycles, manualTransition, undoRule, cancelRule, rescheduleRule, statusLabel } = await import('../../packages/contracts/dist/index.js');
const { BookingLifecycleService: CoreLifecycle } = await import('../../backend/dist/src/application/services/bookingLifecycle.js');
const { BookingLifecycleService: ClinicLifecycle } = await import('../../services/clinic/dist/application/services/bookingLifecycle.js');

const services = [['Core', CoreLifecycle, ['appointment', 'hotel']], ['Clinic', ClinicLifecycle, ['appointment']]];
const clean = { medical: 0, care: 0, invoices: 0 };
// Each guard and the linked data (or invoice state) that violates it.
const violations = { 'no-medical-record': { linked: { medical: 1 } }, 'no-active-invoice': { linked: { invoices: 1 } }, 'no-care-note': { linked: { care: 1 } }, 'final-invoice-paid': { invoice: 'issued' } };
// Care notes belong to hotel stays; both stores report none for an appointment.
const possible = kind => Object.entries(violations).filter(([guard]) => !(kind === 'appointment' && guard === 'no-care-note'));

function run(Service, kind, status, work, { linked = clean, invoice = 'paid', latest = null, ownerId = 'owner-1' } = {}) {
  const log = { saved: [], events: [], notified: [] };
  const booking = { id: 'b1', status, statusRevision: 0, ownerId, internalNote: null };
  const tx = {
    booking, dependencies: async () => ({ ...clean, ...linked }), hotelInvoiceStatus: async () => invoice, latestTransition: async () => latest,
    save: async (to, patch) => { log.saved.push({ to, patch }); return { ...booking, status: to, statusRevision: 1 }; },
    event: async (...args) => { log.events.push(args); }, notify: async (...args) => { log.notified.push(args); },
  };
  const service = new Service({ run: async (_kind, _id, fn) => fn(tx), history: async () => [] });
  return work(service).then(saved => ({ ok: true, saved, log }), error => ({ ok: false, status: error.status, message: error.message, log }));
}
const admin = { sub: 'admin-1', role: 'admin' }, owner = { sub: 'owner-1', role: 'owner' };
const refusedUnchanged = (result, label) => { assert.equal(result.ok, false, label); assert.deepEqual(result.log.saved, [], label + ': nothing saved'); };

for (const [name, Service, kinds] of services) for (const kind of kinds) {
  const { statuses } = bookingLifecycles[kind];

  test(`${name} ${kind}: PATCH status accepts exactly the table's moves, with its guards`, async () => {
    for (const from of statuses) for (const to of statuses) {
      if (from === to) continue;
      const label = `${name} ${kind} ${from} -> ${to}`, rule = manualTransition(kind, from, to);
      const change = service => service.change(admin, kind, 'b1', { status: to, expectedRevision: 0 });
      const result = await run(Service, kind, from, change);
      if (!rule) { refusedUnchanged(result, label); assert.equal(result.status, 409, label); continue; }
      assert.equal(result.ok, true, `${label}: ${result.message}`);
      assert.equal(result.saved.status, to, label);
      assert.equal(result.log.events[0][1], 'transition', label);
      assert.equal(result.log.notified[0][0], `Trạng thái lịch đặt: ${statusLabel(from)} → ${statusLabel(to)}.`, label);
      for (const [guard, violation] of possible(kind)) {
        const guarded = await run(Service, kind, from, change, violation);
        if (rule.guards.includes(guard)) { refusedUnchanged(guarded, `${label} [${guard}]`); assert.equal(guarded.status, 409, `${label} [${guard}]`); }
        else assert.equal(guarded.ok, true, `${label} [${guard}] must not block: ${guarded.message}`);
      }
    }
  });

  test(`${name} ${kind}: undo follows the table's rules, permissions and guards`, async () => {
    for (const from of statuses) {
      const rule = undoRule(kind, from), label = `${name} ${kind} undo ${from}`;
      const latest = { id: 'e1', action: 'transition', toStatus: from, fromStatus: rule?.to ?? 'pending' };
      for (const role of roles.filter(r => r !== 'owner')) {
        const result = await run(Service, kind, from, service => service.undo({ sub: role + '-1', role }, kind, 'b1', { expectedRevision: 0, reason: 'Fixture' }), { latest });
        if (!rule) { refusedUnchanged(result, label); assert.equal(result.status, allows(role, 'booking.manage') ? 409 : 403, `${label} as ${role}`); continue; }
        if (!allows(role, rule.permission)) { refusedUnchanged(result, `${label} as ${role}`); assert.equal(result.status, 403, `${label} as ${role}`); continue; }
        assert.equal(result.ok, true, `${label} as ${role}: ${result.message}`);
        assert.equal(result.saved.status, rule.to, label);
      }
      if (!rule) continue;
      for (const [guard, violation] of possible(kind)) {
        const guarded = await run(Service, kind, from, service => service.undo(admin, kind, 'b1', { expectedRevision: 0, reason: 'Fixture' }), { latest, ...violation });
        if (rule.guards.includes(guard)) refusedUnchanged(guarded, `${label} [${guard}]`);
        else assert.equal(guarded.ok, true, `${label} [${guard}] must not block: ${guarded.message}`);
      }
    }
  });

  test(`${name} ${kind}: owner cancel and reschedule follow the table`, async () => {
    const steps = [['cancel', cancelRule(kind), service => service.cancel(owner, kind, 'b1', 0)]];
    if (kind === 'appointment') steps.push(['reschedule', rescheduleRule(kind), service => service.reschedule(owner, 'b1', 0, { appointmentTime: '10:00' })]);
    else assert.equal(rescheduleRule(kind), null);
    for (const [step, rule, work] of steps) for (const from of statuses) {
      const label = `${name} ${kind} ${step} from ${from}`, result = await run(Service, kind, from, work);
      if (!rule.from.includes(from)) { refusedUnchanged(result, label); assert.equal(result.status, 409, label); continue; }
      assert.equal(result.ok, true, `${label}: ${result.message}`);
      assert.equal(result.saved.status, rule.to, label);
      for (const [guard, violation] of possible(kind)) {
        const guarded = await run(Service, kind, from, work, violation);
        if (rule.guards.includes(guard)) refusedUnchanged(guarded, `${label} [${guard}]`);
        else assert.equal(guarded.ok, true, `${label} [${guard}] must not block: ${guarded.message}`);
      }
      const foreign = await run(Service, kind, from, work, { ownerId: 'someone-else' });
      refusedUnchanged(foreign, label + ' by another owner'); assert.equal(foreign.status, 403);
    }
  });
}
