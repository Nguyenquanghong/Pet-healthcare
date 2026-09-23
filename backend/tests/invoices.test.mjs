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
