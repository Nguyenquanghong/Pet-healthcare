import assert from "node:assert/strict";
import test from "node:test";
import { HotelCapacityService } from "../dist/src/application/services/hotelCapacity.js";

// AQ-10: rooms per type; the database enforces them, the service validates and authorizes changes.
function fixture() {
  const calls = [];
  const repository = {
    list: async () => [{ roomType: "standard", capacity: 10, updatedAt: new Date() }],
    set: async (roomType, capacity, from) => { calls.push({ roomType, capacity, from: from.toISOString().slice(0, 10) }); return { roomType, capacity, updatedAt: new Date() }; },
  };
  return { calls, service: new HotelCapacityService(repository) };
}

test("only an admin changes capacity, to a whole number 0..1000 of a known room type, from today on", async () => {
  const { calls, service } = fixture();
  for (const role of ["owner", "doctor", "staff"]) await assert.rejects(service.set({ sub: role, role }, "vip", { capacity: 3 }), { status: 403 });
  for (const capacity of [-1, 1.5, "3", 1001, undefined]) await assert.rejects(service.set({ sub: "a", role: "admin" }, "vip", { capacity }), { status: 422 });
  await assert.rejects(service.set({ sub: "a", role: "admin" }, "penthouse", { capacity: 1 }), { status: 404 });
  assert.equal((await service.set({ sub: "a", role: "admin" }, "vip", { capacity: 0 })).capacity, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].from, /^\d{4}-\d{2}-\d{2}$/);
});

test("staff read capacities; owners do not", async () => {
  const { service } = fixture();
  for (const role of ["doctor", "staff", "admin"]) assert.equal((await service.list({ sub: role, role })).length, 1);
  await assert.rejects(service.list({ sub: "o", role: "owner" }), { status: 403 });
});
