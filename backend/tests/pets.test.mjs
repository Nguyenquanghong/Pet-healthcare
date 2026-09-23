import assert from "node:assert/strict";
import test from "node:test";
import { PetsService } from "../dist/src/application/services/pets.js";

const owner = { sub: "owner-1", role: "owner" };

test("owner identity and mapped pet fields come from business service", async () => {
  let saved;
  const service = new PetsService({
    create: async (data) => { saved = data; return { id: "pet-1", ...data }; },
  }, { create: () => "qr-test" });
  await service.create(owner, { ownerId: "other-owner", name: " Mochi ", species: "cat", weightKg: "4.2", publicProfile: { showOwnerPhone: false } });
  assert.equal(saved.ownerId, "owner-1");
  assert.equal(saved.name, "Mochi");
  assert.equal(saved.weightKg, 4.2);
  assert.equal(saved.showOwnerPhone, false);
  assert.equal(saved.qrToken, "qr-test");
});

test("owner cannot update another owner's pet", async () => {
  const service = new PetsService({
    find: async () => ({ id: "pet-1", ownerId: "other-owner" }),
    update: async () => { throw new Error("must not update"); },
  }, { create: () => "qr-test" });
  await assert.rejects(service.update(owner, "pet-1", { name: "New" }), { status: 403 });
});
