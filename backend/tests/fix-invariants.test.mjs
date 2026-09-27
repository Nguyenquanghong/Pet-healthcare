import assert from "node:assert/strict";
import test from "node:test";
import { MedicalRecordsService } from "../dist/src/application/services/medicalRecords.js";
import * as serializers from "../dist/src/lib/serialize.js";
import { appointmentSlotWrite } from "../dist/src/infrastructure/persistence/appointmentSlotConflict.js";

const staff = { sub: "staff-1", role: "staff" };
const medicalInput = { petId: "pet-a", appointmentId: "appointment-b", doctorName: "Doctor", visitDate: "2099-01-01", title: "Check", diagnosis: "Healthy", treatment: "Observe" };

function medicalFixture(linkedAppointment) {
  const effects = { record: 0, completion: 0, notification: 0 };
  const records = {
    findPet: async () => ({ id: "pet-a", ownerId: "owner-a", name: "A" }),
    findAppointment: async () => linkedAppointment,
    create: async data => { effects.record++; return { id: "record-a", ...data }; },
    completeAppointment: async () => { effects.completion++; },
  };
  const service = new MedicalRecordsService({
    records,
    unitOfWork: { run: async work => work({ records, notifications: { create: async () => { effects.notification++; } } }) },
  });
  return { service, effects };
}

test("medical link rejects another pet of the same owner before any write", async () => {
  const { service, effects } = medicalFixture({ id: "appointment-b", petId: "pet-b", ownerId: "owner-a" });
  await assert.rejects(service.create(staff, medicalInput), { status: 422 });
  assert.deepEqual(effects, { record: 0, completion: 0, notification: 0 });
});

test("medical link rejects another owner's appointment before any write", async () => {
  const { service, effects } = medicalFixture({ id: "appointment-b", petId: "pet-b", ownerId: "owner-b" });
  await assert.rejects(service.create(staff, medicalInput), { status: 422 });
  assert.deepEqual(effects, { record: 0, completion: 0, notification: 0 });
});

test("medical link returns 404 for an absent appointment and permits standalone records", async () => {
  const { service, effects } = medicalFixture(null);
  await assert.rejects(service.create(staff, medicalInput), { status: 404 });
  assert.deepEqual(effects, { record: 0, completion: 0, notification: 0 });
  await service.create(staff, { ...medicalInput, appointmentId: undefined });
  assert.deepEqual(effects, { record: 1, completion: 0, notification: 1 });
});

test("public pet projection excludes internal notes and respects medical alert flag", () => {
  assert.equal(typeof serializers.publicPetDto, "function", "a dedicated public projection is required");
  const pet = {
    id: "pet-a", ownerId: "owner-a", name: "A", species: "dog", breed: null, gender: "unknown", ageLabel: null,
    weightKg: null, microchipId: null, healthStatus: "critical", allergies: ["PRIVATE_ALLERGY"], notes: "PRIVATE_NOTE",
    avatarUrl: null, identifyingMarks: null, lastSeenLocation: null, qrToken: "qr-a", qrEnabled: true,
    showOwnerPhone: false, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: false, rescueNote: "Public rescue note",
  };
  const hidden = serializers.publicPetDto(pet);
  assert.ok(!JSON.stringify(hidden).includes("PRIVATE_ALLERGY"));
  assert.ok(!JSON.stringify(hidden).includes("PRIVATE_NOTE"));
  assert.ok(!JSON.stringify(hidden).includes("critical"));
  assert.equal(hidden.publicProfile.rescueNote, "Public rescue note");
  const shown = serializers.publicPetDto({ ...pet, showMedicalAlerts: true });
  assert.deepEqual(shown.allergies, ["PRIVATE_ALLERGY"]);
  assert.equal(shown.healthStatus, "critical");
  assert.ok(!JSON.stringify(shown).includes("PRIVATE_NOTE"));
  assert.equal(serializers.petDto(pet).notes, "PRIVATE_NOTE", "owner/staff DTO keeps private data");
});

test("Prisma slot conflict maps only the appointment slot uniqueness error", async () => {
  const slot = { code: "P2002", meta: { modelName: "Appointment", target: ["pet_id", "appointment_date", "appointment_time"] } };
  await assert.rejects(appointmentSlotWrite(Promise.reject(slot)), { status: 409 });
  for (const unrelated of [
    { code: "P2002", meta: { modelName: "Appointment", target: ["id"] } },
    { code: "P2002", meta: { modelName: "Pet", target: ["pet_id", "appointment_date", "appointment_time"] } },
    { code: "P2003", meta: { modelName: "Appointment", target: ["pet_id", "appointment_date", "appointment_time"] } },
  ]) await assert.rejects(appointmentSlotWrite(Promise.reject(unrelated)), error => error === unrelated);
});
