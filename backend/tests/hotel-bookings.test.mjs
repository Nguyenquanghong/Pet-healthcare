import assert from "node:assert/strict";
import test from "node:test";
import { HotelBookingsService } from "../dist/src/application/services/hotelBookings.js";

const staff = { sub: "staff-1", role: "staff" };
const owner = { sub: "owner-1", role: "owner" };

function fixture(failNotification = false) {
  const committed = [];
  const pet = { id: "pet-1", ownerId: "owner-1", name: "Mochi" };
  const existing = { id: "booking-1", petId: pet.id, ownerId: pet.ownerId, checkIn: new Date("2099-01-01"), checkOut: new Date("2099-01-03"), nights: 2, roomType: "standard", serviceKeys: [], totalAmount: 700000, status: "pending", ownerNote: null, internalNote: null, createdAt: new Date(), updatedAt: new Date(), dailyCareNotes: [] };
  const bookings = {
    list: async () => committed,
    findPet: async () => pet,
    findWithPet: async () => ({ booking: existing, petName: pet.name }),
    findForCancel: async () => existing,
    cancel: async () => existing,
  };
  const service = new HotelBookingsService({
    bookings,
    unitOfWork: { run: async (work) => {
      const staged = [];
      const result = await work({
        bookings: {
          ...bookings,
          create: async (data) => { const item = { ...existing, ...data }; staged.push(item); return item; },
          updateStatus: async (_id, status) => ({ ...existing, status }),
          createCareNote: async (data) => ({ ...data, id: "note-1", createdAt: new Date() }),
        },
        notifications: { create: async () => { if (failNotification) throw new Error("notification failed"); } },
      });
      committed.push(...staged);
      return result;
    } },
  });
  return { service, committed };
}

test("hotel pricing and notification share a unit of work", async () => {
  const deps = fixture();
  const booking = await deps.service.create(owner, { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03", roomType: "standard", serviceKeys: ["daily_walk"] });
  assert.equal(booking.nights, 2);
  assert.equal(booking.totalAmount, 820000);
  assert.equal(deps.committed.length, 1);
});

test("hotel notification failure prevents booking commit", async () => {
  const deps = fixture(true);
  await assert.rejects(deps.service.create(owner, { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03" }), /notification failed/);
  assert.equal(deps.committed.length, 0);
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
  const input = { petId: "pet-1", checkIn: "2099-01-01", checkOut: "2099-01-03" };
  for (const invalid of [
    { roomType: "unknown" }, { roomType: "toString" },
    { serviceKeys: ["unknown"] }, { serviceKeys: ["daily_walk", "daily_walk"] },
    { checkIn: "2099-02-31", checkOut: "2099-03-05" }, { checkIn: "bad" },
  ]) await assert.rejects(deps.service.create(owner, { ...input, ...invalid }), { status: 422 });
  await assert.rejects(deps.service.changeStatus(staff, "booking-1", { status: "unknown" }), { status: 422 });
  assert.equal(deps.committed.length, 0);
});
