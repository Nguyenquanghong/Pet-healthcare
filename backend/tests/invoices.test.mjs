import assert from "node:assert/strict";
import test from "node:test";
import { InvoicesService } from "../dist/src/application/services/invoices.js";

test("invoice reads scope owner and payment requires staff", async () => {
  const seen = [];
  const service = new InvoicesService({
    list: async (ownerId) => { seen.push(ownerId); return []; },
    pay: async (id, method, at) => ({ id, paymentMethod: method, paidAt: at }),
  });
  await service.list({ sub: "owner-1", role: "owner" }, "other");
  await service.list({ sub: "staff-1", role: "staff" }, "other");
  assert.deepEqual(seen, ["owner-1", "other"]);
  assert.throws(() => service.pay({ sub: "owner-1", role: "owner" }, "invoice-1"), { status: 403 });
  const result = await service.pay({ sub: "staff-1", role: "staff" }, "invoice-1");
  assert.equal(result.paymentMethod, "cash");
  assert.ok(result.paidAt instanceof Date);
});

test("invoice issuance rejects invalid amounts, unfinished services and owner writes", async () => {
  let status = "completed";
  let created;
  const service = new InvoicesService({ issue: work => work({
    source: async () => ({ status, ownerId: "actual-owner", petId: "actual-pet", description: "Consultation", amount: 300000 }),
    create: async data => { created = data; return data; },
    notify: async () => {},
  }) });
  const staff = { sub: "staff", role: "staff" };
  const input = { type: "appointment", relatedId: "appointment", subtotal: 250000, taxAmount: 20000, discountAmount: 10000, ownerId: "forged" };
  assert.throws(() => service.create({ sub: "owner", role: "owner" }, input), { status: 403 });
  for (const type of [null, [], {}, { toString: "appointment" }, 1, "other"]) {
    assert.throws(() => service.create(staff, { ...input, type }), { status: 422 });
  }
  for (const subtotal of [-1, 0.5, "250000", Infinity, 10000000000, undefined]) {
    assert.throws(() => service.create(staff, { ...input, subtotal }), { status: 422 });
  }
  assert.throws(() => service.pay(staff, "invoice", "bitcoin"), { status: 422 });
  assert.throws(() => service.pay(staff, "invoice", "credit_card"), { status: 422 });
  assert.throws(() => service.pay(staff, "invoice", null), { status: 422 });
  await assert.rejects(service.create(staff, { ...input, discountAmount: 300000 }), { status: 422 });
  status = "pending";
  await assert.rejects(service.create(staff, input), { status: 409 });
  status = "completed";
  await service.create(staff, input);
  assert.equal(created.totalAmount, 260000);
  assert.equal(created.ownerId, "actual-owner");
  assert.equal(created.petId, "actual-pet");
  status = "checked_out";
  await service.create(staff, { type: "hotel_booking", relatedId: "booking" });
  assert.equal(created.subtotal, 300000);
  assert.throws(() => service.create(staff, { type: "hotel_booking", relatedId: "booking", subtotal: 1 }), { status: 422 });
});
