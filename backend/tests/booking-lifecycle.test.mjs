import assert from "node:assert/strict";
import test from "node:test";
import { BookingLifecycleService } from "../dist/src/application/services/bookingLifecycle.js";
const staff = { sub: "staff", role: "staff" }, admin = { sub: "admin", role: "admin" }, owner = { sub: "owner", role: "owner" };
function fixture(status = "confirmed", linked = {}, paymentStatus = null) {
  const events = [], notices = [];
  let booking = { id: "b", ownerId: "owner", status, statusRevision: 0 };
  const service = new BookingLifecycleService({
    history: async () => events,
    run: async (_kind, _id, work) => work({ booking,
      dependencies: async () => ({ medical: 0, care: 0, invoices: 0, ...linked }),
      hotelInvoiceStatus: async () => paymentStatus,
      latestTransition: async () => events.at(-1) || null,
      save: async (next) => booking = { ...booking, status: next, statusRevision: booking.statusRevision + 1 },
      event: async (actor, action, fromStatus, toStatus, revision, reason, reversesId) => events.push({ id: `event-${revision}`, actorId: actor.sub, action, fromStatus, toStatus, revision, reason, reversesId }),
      notify: async message => notices.push(message),
    }),
  });
  return { service, events, notices, get booking() { return booking; } };
}
test("check-in reversal keeps original event, records actor/reason and returns booking to confirmed", async () => {
  const f = fixture();
  await f.service.change(staff, "appointment", "b", { status: "checked_in", expectedRevision: 0 });
  await f.service.undo(staff, "appointment", "b", { reason: "Wrong pet", expectedRevision: 1 });
  assert.equal(f.booking.status, "confirmed"); assert.equal(f.events.length, 2); assert.equal(f.notices.length, 2);
  assert.equal(f.events[0].toStatus, "checked_in"); assert.equal(f.events[1].reversesId, f.events[0].id);
  assert.equal(f.events[1].reason, "Wrong pet"); assert.equal(f.events[1].actorId, staff.sub);
});
test("hotel checkout requires a paid final invoice and admin undo preserves the financial record", async () => {
  const none = fixture("in_stay");
  await assert.rejects(none.service.change(staff, "hotel", "b", { status: "checked_out", expectedRevision: 0 }), { status: 409 });
  const unpaid = fixture("in_stay", { invoices: 1 }, "unpaid");
  await assert.rejects(unpaid.service.change(staff, "hotel", "b", { status: "checked_out", expectedRevision: 0 }), { status: 409 });
  const paid = fixture("in_stay", { invoices: 1, care: 1 }, "paid");
  await paid.service.change(staff, "hotel", "b", { status: "checked_out", expectedRevision: 0 });
  await assert.rejects(paid.service.undo(staff, "hotel", "b", { reason: "Wrong handover", expectedRevision: 1 }), { status: 403 });
  await paid.service.undo(admin, "hotel", "b", { reason: "Wrong handover", expectedRevision: 1 });
  assert.equal(paid.booking.status, "in_stay");
  assert.equal(paid.events[1].reversesId, paid.events[0].id);
  await paid.service.change(staff, "hotel", "b", { status: "checked_out", expectedRevision: 2 });
  assert.equal(paid.booking.status, "checked_out");
});
test("guards reject missing/stale revision, skipping stages, owner actions and empty undo reason", async () => {
  const f = fixture();
  assert.throws(() => f.service.change(owner, "appointment", "b", {}), { status: 403 });
  assert.throws(() => f.service.history(owner, "appointment", "b"), { status: 403 });
  await assert.rejects(f.service.change(staff, "appointment", "b", { status: "checked_in" }), { status: 422 });
  await assert.rejects(f.service.change(staff, "appointment", "b", { status: "completed", expectedRevision: 0 }), { status: 409 });
  await assert.rejects(f.service.change(staff, "appointment", "b", { status: "checked_in", expectedRevision: 1 }), { status: 409 });
  assert.throws(() => f.service.undo(staff, "appointment", "b", { reason: " " }), { status: 422 });
  assert.equal(f.events.length, 0);
});
test("dependent records and legacy bookings block check-in reversal", async () => {
  for (const [kind, status, linked] of [["appointment", "checked_in", { medical: 1 }], ["appointment", "checked_in", { invoices: 1 }], ["hotel", "in_stay", { care: 1 }], ["hotel", "in_stay", {}]]) {
    const f = fixture(status, linked);
    await assert.rejects(f.service.undo(staff, kind, "b", { reason: "Mistake", expectedRevision: 0 }), { status: 409 });
    assert.equal(f.events.length, 0);
  }
});
test("only admin reopens completed services; starting work disables quick check-in reversal", async () => {
  const f = fixture();
  for (const status of ["checked_in", "in_progress", "completed"]) {
    await f.service.change(staff, "appointment", "b", { status, expectedRevision: f.booking.statusRevision });
    if (status === "in_progress") await assert.rejects(f.service.undo(staff, "appointment", "b", { reason: "Mistake", expectedRevision: 2 }), { status: 409 });
  }
  await assert.rejects(f.service.undo(staff, "appointment", "b", { reason: "Mistake", expectedRevision: 3 }), { status: 403 });
  await f.service.undo(admin, "appointment", "b", { reason: "Premature completion", expectedRevision: 3 });
  assert.equal(f.booking.status, "in_progress");
});
