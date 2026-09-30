import assert from "node:assert/strict";
import test from "node:test";
import { HotelBookingsService } from "../dist/src/application/services/hotelBookings.js";

const staff = { sub: "staff-1", role: "staff" };
const owner = { sub: "owner-1", role: "owner" };

function fixture(failNotification = false) {
  const committed = [];
  const requests = new Map();
  let noticeCount = 0;
  const pet = { id: "pet-1", ownerId: "owner-1", name: "Mochi" };
  const existing = { id: "booking-1", petId: pet.id, ownerId: pet.ownerId, checkIn: new Date("2099-01-01"), checkOut: new Date("2099-01-03"), nights: 2, roomType: "standard", serviceKeys: [], totalAmount: 700000, status: "pending", ownerNote: null, internalNote: null, createdAt: new Date(), updatedAt: new Date(), dailyCareNotes: [] };
  const bookings = {
    list: async () => committed,
    find: async id => committed.find(item => item.id === id) ?? null,
    findPet: async () => pet,
    findWithPet: async () => ({ booking: existing, petName: pet.name }),
    lockActor: async () => {},
    lockPet: async () => {},
    findRequest: async (actorId, key) => requests.get(`${actorId}:${key}`) ?? null,
    hasOverlappingStay: async (petId, checkIn, checkOut) => committed.some(item => item.petId === petId &&
      ["pending", "confirmed", "in_stay"].includes(item.status) && item.checkIn < checkOut && item.checkOut > checkIn),
  };
  const service = new HotelBookingsService({
    bookings,
    unitOfWork: { run: async (work) => {
      const staged = [];
      const stagedRequests = [];
      const result = await work({
        bookings: {
          ...bookings,
          create: async (data) => { const item = { ...existing, ...data }; staged.push(item); return item; },
          saveRequest: async (...args) => { stagedRequests.push(args); },
          createCareNote: async (data) => ({ ...data, id: "note-1", createdAt: new Date() }),
        },
        notifications: { create: async () => { if (failNotification) throw new Error("notification failed"); noticeCount++; } },
      });
      committed.push(...staged);
      for (const [actorId, key, fingerprint, bookingId] of stagedRequests)
        requests.set(`${actorId}:${key}`, { fingerprint, bookingId });
      return result;
    } },
  });
  return { service, committed, get noticeCount() { return noticeCount; } };
}

test("hotel pricing and notification share a unit of work", async () => {
  const deps = fixture();
  const booking = await deps.service.create(owner, { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03", roomType: "standard", serviceKeys: ["daily_walk"], requestKey: "test-booking-key-0001" });
  assert.equal(booking.nights, 2);
  assert.equal(booking.totalAmount, 820000);
  assert.equal(deps.committed.length, 1);
});

test("hotel notification failure prevents booking commit", async () => {
  const deps = fixture(true);
  await assert.rejects(deps.service.create(owner, { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03", requestKey: "test-booking-key-0002" }), /notification failed/);
  assert.equal(deps.committed.length, 0);
});

test("replay returns the original booking without another notification; mismatched key and overlapping stay conflict", async () => {
  const f = fixture();
  const input = { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03", requestKey: "replay-booking-key-001" };
  const first = await f.service.create(owner, input);
  const replay = await f.service.create(owner, { ...input, serviceKeys: [] });
  assert.equal(first.id, replay.id);
  assert.equal(f.committed.length, 1);
  assert.equal(f.noticeCount, 1);
  await assert.rejects(f.service.create(owner, { ...input, roomType: "deluxe" }), { status: 409 });
  await assert.rejects(f.service.create(owner, { ...input, requestKey: "another-booking-key-01" }), { status: 409 });
  await f.service.create(owner, { ...input, checkIn: "2099-01-03", checkOut: "2099-01-04", requestKey: "adjacent-booking-key-01" });
  assert.equal(f.committed.length, 2);
});

test("old booking can be replayed after its check-in date passes, but a new past booking cannot", async () => {
  const originalNow = Date.now;
  const f = fixture();
  const input = { petId: "pet-1", checkIn: "2098-01-02", checkOut: "2098-01-03", requestKey: "past-replay-booking-key" };
  try {
    Date.now = () => new Date("2098-01-01T00:00:00.000Z").getTime();
    const first = await f.service.create(owner, input);
    Date.now = () => new Date("2098-01-05T00:00:00.000Z").getTime();
    assert.equal((await f.service.create(owner, input)).id, first.id);
    await assert.rejects(f.service.create(owner, { ...input, requestKey: "new-past-booking-key-01" }), { status: 422 });
  } finally { Date.now = originalNow; }
});

test("care note requires staff and a nonblank note", async () => {
  const deps = fixture();
  await assert.rejects(deps.service.addCareNote(owner, "booking-1", { note: "Fed" }), { status: 403 });
  await assert.rejects(deps.service.addCareNote(staff, "booking-1", { note: "  " }), { status: 422 });
  const result = await deps.service.addCareNote(staff, "booking-1", { note: "  Fed  ", visibleToOwner: false });
  assert.equal(result.note, "Fed");
  assert.equal(result.visibleToOwner, false);
});

test("invalid dates, room, services and status fail before persistence", async () => {
  const deps = fixture();
  const input = { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03", requestKey: "test-booking-key-0003" };
  for (const invalid of [
    { roomType: "unknown" }, { roomType: "toString" }, { roomType: 0 },
    { serviceKeys: ["unknown"] }, { serviceKeys: ["daily_walk", "daily_walk"] },
    { checkIn: "2099-02-31", checkOut: "2099-03-05" }, { checkIn: "bad" }, { checkIn: 123 },
    { checkOut: "9999-12-31" },
  ]) await assert.rejects(deps.service.create(owner, { ...input, ...invalid }), { status: 422 });
  await assert.rejects(deps.service.changeStatus(staff, "booking-1", { status: "unknown" }), { status: 422 });
  assert.equal(deps.committed.length, 0);
});
