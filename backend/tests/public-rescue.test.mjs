import assert from "node:assert/strict";
import test from "node:test";
import { PublicRescueService } from "../dist/src/application/services/publicRescue.js";

const pet = { id: "pet-1", ownerId: "owner-1", name: "Mochi", showOwnerPhone: false, showOwnerEmail: true, showOwnerAddress: false };
const owner = { id: "owner-1", fullName: "Owner", phone: "123", email: "owner@example.test", address: "Home" };

function fixture(failNotification = false, clock = { now: new Date("2026-10-23T10:00:00Z") }) {
  const committed = [], notified = [], locks = [];
  const reads = { findEnabledPetWithOwner: async () => ({ pet, owner }), findEnabledPetForReport: async () => pet };
  const service = new PublicRescueService({
    reads,
    unitOfWork: { run: async (work) => {
      let pending, notice;
      const result = await work({
        ...reads,
        lockPet: async (id) => { locks.push(id); },
        hasRecentReport: async (petId, phone, since) => committed.some(r => r.petId === petId && r.finderPhone === phone && r.at >= since),
        createReport: async (data) => { pending = { ...data, at: clock.now }; },
        notifyOwner: async (data) => { if (failNotification) throw new Error("notification failed"); notice = data; },
      });
      if (pending) committed.push(pending);
      if (notice) notified.push(notice);
      return result;
    } },
  }, () => clock.now);
  return { service, committed, notified, locks, clock };
}

test("public contact masking follows stored flags", async () => {
  const result = await fixture().service.getPet("qr");
  assert.equal(result.owner.phone, "");
  assert.equal(result.owner.email, "owner@example.test");
  assert.equal(result.owner.address, undefined);
});

test("rescue report and owner notification share a unit of work", async () => {
  const deps = fixture();
  await deps.service.report("qr", { finderPhone: " 123 ", location: " Park " });
  const { at, ...stored } = deps.committed[0];
  assert.deepEqual(stored, { petId: "pet-1", finderPhone: "123", location: "Park", finderName: null, note: null });
  const failing = fixture(true);
  await assert.rejects(failing.service.report("qr", { finderPhone: "123", location: "Park" }), /notification failed/);
  assert.equal(failing.committed.length, 0);
});

test("AQ-01: a repeated report from the same finder within 10 minutes is merged, not notified again", async () => {
  const deps = fixture();
  assert.deepEqual(await deps.service.report("qr", { finderPhone: "0901", location: "Park" }), { merged: false });
  deps.clock.now = new Date(deps.clock.now.getTime() + 9 * 60 * 1000);
  assert.deepEqual(await deps.service.report("qr", { finderPhone: " 0901 ", location: "Gate" }), { merged: true });
  assert.equal(deps.committed.length, 1);
  assert.equal(deps.notified.length, 1);
  assert.deepEqual(await deps.service.report("qr", { finderPhone: "0902", location: "Park" }), { merged: false }, "another finder is a new report");
  deps.clock.now = new Date(deps.clock.now.getTime() + 11 * 60 * 1000);
  assert.deepEqual(await deps.service.report("qr", { finderPhone: "0901", location: "Park" }), { merged: false }, "after the window it is a new report");
  assert.equal(deps.committed.length, 3);
  assert.equal(deps.notified.length, 3);
  assert.deepEqual(deps.locks, ["pet-1", "pet-1", "pet-1", "pet-1"], "every report takes the pet lock before the duplicate check");
});
