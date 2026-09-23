import assert from "node:assert/strict";
import test from "node:test";
import { BootstrapService } from "../dist/src/application/services/bootstrap.js";

test("bootstrap uses owner scope and preserves aggregate response keys", async () => {
  const calls = [];
  const repository = { load: async (isAdmin, ownerId) => {
    calls.push({ isAdmin, ownerId });
    return { owners: [{ id: "owner-1" }], pets: [], appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [] };
  } };
  const service = new BootstrapService(repository);
  const owner = await service.load({ sub: "owner-1", role: "owner" });
  const admin = await service.load({ sub: "admin-1", role: "admin" });
  assert.deepEqual(calls, [{ isAdmin: false, ownerId: "owner-1" }, { isAdmin: true, ownerId: undefined }]);
  assert.equal(owner.currentOwnerId, "owner-1");
  assert.equal(admin.currentOwnerId, "owner-1");
  assert.deepEqual(Object.keys(owner).sort(), ["currentOwnerId", "owners", "pets", "appointments", "medicalRecords", "medicalImages", "hotelBookings", "dailyCareNotes", "notifications"].sort());
});
