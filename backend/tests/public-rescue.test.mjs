import assert from "node:assert/strict";
import test from "node:test";
import { PublicRescueService } from "../dist/src/application/services/publicRescue.js";

const pet = { id: "pet-1", ownerId: "owner-1", name: "Mochi", showOwnerPhone: false, showOwnerEmail: true, showOwnerAddress: false };
const owner = { id: "owner-1", fullName: "Owner", phone: "123", email: "owner@example.test", address: "Home" };

function fixture(failNotification = false) {
  const committed = [];
  const reads = { findEnabledPetWithOwner: async () => ({ pet, owner }), findEnabledPetForReport: async () => pet };
  const service = new PublicRescueService({
    reads,
    unitOfWork: { run: async (work) => {
      let pending;
      const result = await work({
        ...reads,
        createReport: async (data) => { pending = data; },
        notifyOwner: async () => { if (failNotification) throw new Error("notification failed"); },
      });
      if (pending) committed.push(pending);
      return result;
    } },
  });
  return { service, committed };
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
  assert.deepEqual(deps.committed[0], { petId: "pet-1", finderPhone: "123", location: "Park", finderName: null, note: null });
  const failing = fixture(true);
  await assert.rejects(failing.service.report("qr", { finderPhone: "123", location: "Park" }), /notification failed/);
  assert.equal(failing.committed.length, 0);
});
