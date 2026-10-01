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

test("staff creates a pet for an existing owner selected at reception", async () => {
  let saved;
  const service = new PetsService({
    ownerExists: async (id) => id === "owner-2",
    create: async (data) => { saved = data; return { id: "pet-2", ...data }; },
  }, { create: () => "qr-test" });
  await service.create({ sub: "admin-1", role: "admin" }, { ownerId: "owner-2", name: " Milo " });
  assert.equal(saved.ownerId, "owner-2");
  assert.equal(saved.name, "Milo");
});

test("staff cannot attach a pet to a missing user or a staff account", async () => {
  const service = new PetsService({
    ownerExists: async () => false,
    create: async () => { throw new Error("must not create"); },
  }, { create: () => "qr-test" });
  for (const ownerId of ["missing-owner", "admin-1"])
    await assert.rejects(service.create({ sub: "admin-1", role: "admin" }, { ownerId, name: "Milo" }), { status: 422 });
});
