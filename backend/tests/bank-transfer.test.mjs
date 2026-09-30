import assert from "node:assert/strict";
import test from "node:test";
import { bankTransferConfig } from "../dist/src/infrastructure/config/bankTransfer.js";
import { InvoicesService } from "../dist/src/application/services/invoices.js";
import { VnpaySandboxGateway } from "../dist/src/infrastructure/security/vnpay.js";

test("phase 1 defaults to clearly marked demo bank details; incomplete live configuration disables transfers", () => {
  assert.equal(bankTransferConfig({}).isDemo, true);
  assert.equal(bankTransferConfig({}).accountNumber, "0000000000");
  assert.equal(bankTransferConfig({ BANK_TRANSFER_DEMO: "false" }), null);
  const details = bankTransferConfig({ BANK_TRANSFER_DEMO: "false", BANK_TRANSFER_BANK_NAME: "Test Bank",
    BANK_TRANSFER_BANK_BIN: "970436", BANK_TRANSFER_ACCOUNT_NUMBER: "123456789", BANK_TRANSFER_ACCOUNT_HOLDER: "TEST ONLY" });
  assert.equal(details.isDemo, false);
  assert.equal(details.accountNumber, "123456789");
  assert.equal(new VnpaySandboxGateway({ active: false, tmnCode: "TESTCODE", hashSecret: "synthetic-secret-for-tests", returnUrl: "http://localhost:5173/owner/billing" }).enabled(), false);
});
test("manual transfer service enforces roles, configured recipient and bounded customer references/review notes", async () => {
  const owner = { sub: "owner", role: "owner" }, staff = { sub: "staff", role: "staff" };
  const seen = [];
  const service = new InvoicesService({
    chooseTransfer: async (...args) => seen.push(args),
    reportTransfer: async (...args) => seen.push(args),
    rejectTransfer: async (...args) => seen.push(args),
  }, bankTransferConfig({}));
  assert.throws(() => service.chooseTransfer(staff, "invoice"), { status: 403 });
  assert.throws(() => new InvoicesService({}).chooseTransfer(owner, "invoice"), { status: 409 });
  assert.throws(() => service.reportTransfer(staff, "invoice", ""), { status: 403 });
  for (const value of [null, {}, 1, "a".repeat(101)])
    assert.throws(() => service.reportTransfer(owner, "invoice", value), { status: 422 });
  assert.throws(() => service.rejectTransfer(owner, "invoice", "reason"), { status: 403 });
  for (const value of [undefined, "", " ", "a".repeat(501)])
    assert.throws(() => service.rejectTransfer(staff, "invoice", value), { status: 422 });
  await service.chooseTransfer(owner, "invoice");
  await service.reportTransfer(owner, "invoice", "  TEST-123  ");
  await service.rejectTransfer(staff, "invoice", "  Chưa thấy tiền  ");
  assert.equal(seen[0][2].isDemo, true);
  assert.deepEqual(seen[1], ["invoice", "owner", "TEST-123"]);
  assert.deepEqual(seen[2], ["invoice", "Chưa thấy tiền"]);
});
