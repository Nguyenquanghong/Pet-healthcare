import assert from "node:assert/strict";
import test from "node:test";
import { AppointmentService } from "../dist/src/application/services/appointments.js";

const owner = { sub: "owner-1", role: "owner" };
const staff = { sub: "staff-1", role: "staff" };
const input = { petId: "pet-1", type: "spa_bath", serviceName: "Bath", date: "2099-01-01", time: "10:00" };

function fixture({ failNotification = false, conflict = false } = {}) {
  const committed = [];
  let notifications = 0;
  const pet = { id: "pet-1", ownerId: "owner-1", name: "Mochi" };
  const existing = { id: "appt-1", petId: pet.id, ownerId: pet.ownerId, doctorId: null, type: "spa_bath", serviceName: "Bath", clinicName: "Nippon Pet Care", appointmentDate: new Date("2099-01-01T00:00:00.000Z"), appointmentTime: "10:00", status: "pending", ownerNote: null, internalNote: null, createdBy: "owner", createdAt: new Date(), updatedAt: new Date() };
  const base = {
    list: async () => committed,
    findPet: async (id) => id === pet.id ? pet : null,
    find: async (id) => id === existing.id ? existing : null,
    findWithPet: async (id) => id === existing.id ? { appointment: existing, pet } : null,
    hasSlot: async () => conflict,
    create: async (data) => ({ ...existing, ...data }),
    update: async (_id, data) => ({ ...existing, ...data }),
  };
  const service = new AppointmentService({
    appointments: base,
    notifications: { create: async () => { notifications++; } },
    unitOfWork: { run: async (work) => {
      const staged = [];
      const result = await work({
        appointments: { ...base, create: async (data) => { const item = { ...existing, ...data }; staged.push(item); return item; } },
        notifications: { create: async () => { if (failNotification) throw new Error("notification write failed"); notifications++; } },
      });
      committed.push(...staged);
      return result;
    } },
  });
  return { service, committed, get notifications() { return notifications; } };
}

test("owner creates a spa appointment and notification in one unit of work", async () => {
  const deps = fixture();
  const result = await deps.service.create(owner, input);
  assert.equal(result.type, "spa_bath");
  assert.equal(deps.committed.length, 1);
  assert.equal(deps.notifications, 1);
});

test("notification failure rolls back the appointment unit of work", async () => {
  const deps = fixture({ failNotification: true });
  await assert.rejects(deps.service.create(owner, input), /notification write failed/);
  assert.equal(deps.committed.length, 0);
});

test("owner cannot book another owner's pet", async () => {
  const deps = fixture();
  await assert.rejects(deps.service.create({ sub: "other", role: "owner" }, input), { status: 403 });
  assert.equal(deps.committed.length, 0);
});

test("existing slot keeps conflict response before transaction", async () => {
  const deps = fixture({ conflict: true });
  await assert.rejects(deps.service.create(owner, input), { status: 409 });
  assert.equal(deps.committed.length, 0);
});

test("status change requires staff and keeps notification write", async () => {
  const deps = fixture();
  await assert.rejects(deps.service.changeStatus(owner, "appt-1", { status: "confirmed" }), { status: 403 });
  const changed = await deps.service.changeStatus(staff, "appt-1", { status: "confirmed" });
  assert.equal(changed.status, "confirmed");
  assert.equal(deps.notifications, 1);
});

test("impossible calendar dates are rejected instead of rolling over", async () => {
  const deps = fixture();
  await assert.rejects(deps.service.create(owner, { ...input, date: "2099-02-31" }), { status: 422 });
  await assert.rejects(deps.service.reschedule(owner, "appt-1", { date: "2099-02-31", time: "10:00" }), { status: 422 });
  assert.equal(deps.committed.length, 0);
});
