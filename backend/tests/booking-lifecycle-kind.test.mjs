import assert from "node:assert/strict";
import test from "node:test";
import { BookingLifecycleService, lifecycleByKind } from "../dist/src/application/services/bookingLifecycle.js";
import { BusinessError } from "../dist/src/domain/error.js";

const fakeStore = name => {
  const calls = [];
  return {
    calls,
    run: async (kind, id, work) => {
      calls.push(["run", kind, id]);
      return work({ name, booking: { id, status: "pending", statusRevision: 0, ownerId: "o", petId: "p" } });
    },
    history: async (kind, id) => {
      calls.push(["history", kind, id]);
      return [{ store: name }];
    },
  };
};
const notFound = error => error instanceof BusinessError && error.status === 404 && error.message === "Không tìm thấy lịch đặt.";

test("lifecycleByKind sends each kind to its own store and passes kind, id and work through", async () => {
  const hotel = fakeStore("hotel");
  const appointment = fakeStore("appointment");
  const store = lifecycleByKind({ hotel, appointment });
  assert.equal(await store.run("hotel", "h1", async tx => tx.name), "hotel");
  assert.equal(await store.run("appointment", "a1", async tx => tx.name), "appointment");
  assert.deepEqual(await store.history("hotel", "h2"), [{ store: "hotel" }]);
  assert.deepEqual(await store.history("appointment", "a2"), [{ store: "appointment" }]);
  assert.deepEqual(hotel.calls, [["run", "hotel", "h1"], ["history", "hotel", "h2"]]);
  assert.deepEqual(appointment.calls, [["run", "appointment", "a1"], ["history", "appointment", "a2"]]);
});

test("a kind without a store is a missing booking: 404 with the usual sentence, and the other store is untouched", async () => {
  const hotel = fakeStore("hotel");
  const store = lifecycleByKind({ hotel });
  await assert.rejects(store.run("appointment", "a1", async () => assert.fail("work must not run")), notFound);
  await assert.rejects(store.history("appointment", "a1"), notFound);
  assert.deepEqual(hotel.calls, []);
  assert.equal(await store.run("hotel", "h1", async tx => tx.name), "hotel");
});

test("an empty map rejects both kinds", async () => {
  const store = lifecycleByKind({});
  for (const kind of ["hotel", "appointment"]) {
    await assert.rejects(store.run(kind, "x", async () => 1), notFound);
    await assert.rejects(store.history(kind, "x"), notFound);
  }
});

test("BookingLifecycleService on a hotel-only map answers an appointment change with 404 before any write", async () => {
  const hotel = fakeStore("hotel");
  const service = new BookingLifecycleService(lifecycleByKind({ hotel }));
  const staff = { sub: "staff-1", role: "staff" };
  await assert.rejects(service.change(staff, "appointment", "a1", { status: "confirmed", expectedRevision: 0 }), notFound);
  await assert.rejects(service.history(staff, "appointment", "a1"), notFound);
  assert.deepEqual(hotel.calls, []);
});
