import assert from "node:assert/strict";
import test from "node:test";
import { MedicalRecordsService } from "../dist/src/application/services/medicalRecords.js";

const staff = { sub: "staff-1", role: "staff" };
const owner = { sub: "owner-1", role: "owner" };
const input = { petId: "pet-1", appointmentId: "appt-1", doctorName: "Dr A", visitDate: "2099-01-01", title: "Check", diagnosis: "Healthy", treatment: "None" };

function fixture(failNotification = false) {
  const committed = [];
  const completed = [];
  const pet = { id: "pet-1", ownerId: "owner-1", name: "Mochi" };
  const records = {
    list: async () => committed,
    findPet: async () => pet,
    findAppointment: async () => ({ id: "appt-1", petId: pet.id, ownerId: pet.ownerId }),
    find: async () => null,
    create: async (data) => ({ ...data, id: "record-1", createdAt: new Date(), updatedAt: new Date() }),
  };
  const service = new MedicalRecordsService({
    records,
    unitOfWork: { run: async (work) => {
      let pendingRecord;
      let pendingCompletion;
      const result = await work({
        records: {
          ...records,
          create: async (data) => { pendingRecord = await records.create(data); return pendingRecord; },
          completeAppointment: async (id) => { pendingCompletion = id; },
        },
        notifications: { create: async () => { if (failNotification) throw new Error("notification failed"); } },
      });
      if (pendingRecord) committed.push(pendingRecord);
      if (pendingCompletion) completed.push(pendingCompletion);
      return result;
    } },
  });
  return { service, committed, completed };
}

test("medical creation completes linked appointment and writes notification atomically", async () => {
  const deps = fixture();
  const result = await deps.service.create(staff, input);
  assert.equal(result.appointmentId, "appt-1");
  assert.equal(deps.committed.length, 1);
  assert.deepEqual(deps.completed, ["appt-1"]);
});

test("medical notification failure rolls back record and linked appointment", async () => {
  const deps = fixture(true);
  await assert.rejects(deps.service.create(staff, input), /notification failed/);
  assert.equal(deps.committed.length, 0);
  assert.equal(deps.completed.length, 0);
});

test("owner cannot create medical record", async () => {
  const deps = fixture();
  await assert.rejects(deps.service.create(owner, input), { status: 403 });
  assert.equal(deps.committed.length, 0);
});

test("medical update rejects reassignment or unlinking and accepts editable details", async () => {
  const current = { id: "record-1", petId: "pet-1", ownerId: "owner-1", appointmentId: "appt-1", title: "Check" };
  const writes = [];
  const service = new MedicalRecordsService({ records: {
    find: async () => current,
    update: async (_id, data) => { writes.push(data); return { ...current, ...data }; },
  } });
  for (const change of [{ petId: "pet-2" }, { petId: null }, { ownerId: "owner-2" },
    { appointmentId: null }, { appointmentId: "appt-2" }]) {
    await assert.rejects(service.update(staff, current.id, change), { status: 422 });
  }
  assert.equal(writes.length, 0);
  const saved = await service.update(staff, current.id, { title: "Revised", petId: current.petId,
    ownerId: current.ownerId, appointmentId: current.appointmentId });
  assert.equal(saved.title, "Revised");
  assert.deepEqual(writes, [{ title: "Revised" }]);
  await assert.rejects(service.update(owner, current.id, { title: "Invalid" }), { status: 403 });
});
