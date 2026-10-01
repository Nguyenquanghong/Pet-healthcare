import assert from "node:assert/strict";
import test from "node:test";
import { OwnersService } from "../dist/src/application/services/owners.js";
const staff = { sub: "staff-1", role: "staff" };

test("counter customer creation normalizes contact fields and accepts no email/password", async () => {
  let saved;
  const service = new OwnersService({ findByContact: async () => null, createCounterOwner: async data => { saved = data; return { id: "counter-owner", ...data }; } });
  await service.create(staff, { fullName: " Khách tại quầy ", phone: "+84 (912) 345-678", role: "admin", password: "must-not-be-used" });
  assert.deepEqual(saved, { fullName: "Khách tại quầy", phone: "0912345678", email: null, address: null });
  await service.create(staff, { fullName: "Khách", phone: "0912345678", email: " CONTACT@EXAMPLE.TEST ", address: " Hà Nội " });
  assert.equal(saved.email, "contact@example.test");
  assert.equal(saved.address, "Hà Nội");
});

test("owners and doctors cannot create customer profiles", async () => {
  const service = new OwnersService({ findByContact: async () => { throw new Error("must not access data"); } });
  for (const role of ["owner", "doctor"])
    await assert.rejects(service.create({ sub: "actor", role }, { fullName: "Khách", phone: "0912345678" }), { status: 403 });
});

test("invalid counter contact is rejected before any database write", async () => {
  const service = new OwnersService({ findByContact: async () => { throw new Error("must not access data"); } });
  for (const invalid of [{ fullName: " " }, { fullName: "x".repeat(101) }, { phone: "abc" }, { phone: "123" },
    { email: "wrong" }, { email: 10 }, { address: {} }, { address: "x".repeat(501) }])
    await assert.rejects(service.create(staff, { fullName: "Khách", phone: "0912345678", ...invalid }), { status: 422 });
});

test("a matching contact does not create or overwrite the existing customer", async () => {
  let searched;
  const service = new OwnersService({
    findByContact: async (...args) => { searched = args; return { id: "existing-owner" }; },
    createCounterOwner: async () => { throw new Error("must not create"); },
  });
  await assert.rejects(service.create(staff, { fullName: "Tên khác", phone: "84912345678" }), { status: 409 });
  assert.deepEqual(searched, ["0912345678", null]);
});
