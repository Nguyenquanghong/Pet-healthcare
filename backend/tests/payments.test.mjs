import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { VnpaySandboxGateway, canonicalVnpay, signVnpay } from "../dist/src/infrastructure/security/vnpay.js";
import { PaymentsService } from "../dist/src/application/services/payments.js";

const secret = "synthetic-unit-test-secret-only";
const gateway = new VnpaySandboxGateway({ tmnCode: "TESTCODE", hashSecret: secret, returnUrl: "http://localhost:5173/owner/billing" });
const attempt = { id: "reference", invoiceId: "invoice", amount: 250000, status: "pending", createdAt: new Date("2030-01-01T01:00:00Z"), expiresAt: new Date("2030-01-01T01:15:00Z") };
const params = { vnp_TmnCode: "TESTCODE", vnp_TxnRef: "reference", vnp_Amount: "25000000", vnp_ResponseCode: "00", vnp_TransactionStatus: "00", vnp_TransactionNo: "123456" };
const signed = data => ({ ...data, vnp_SecureHash: signVnpay(data, secret) });

test("VNPay canonical signing, VND minor units and GMT+7 expiry", () => {
  assert.equal(canonicalVnpay({ z: "a b", a: "x&y" }), "a=x%26y&z=a+b");
  assert.equal(signVnpay({ z: "a b", a: "x&y" }, secret), createHmac("sha512", secret).update("a=x%26y&z=a+b").digest("hex"));
  const url = new URL(gateway.url(attempt, "::ffff:127.0.0.1"));
  assert.equal(url.origin, "https://sandbox.vnpayment.vn");
  assert.equal(url.searchParams.get("vnp_Amount"), "25000000");
  assert.equal(url.searchParams.get("vnp_CreateDate"), "20300101080000");
  assert.equal(url.searchParams.get("vnp_ExpireDate"), "20300101081500");
  assert.equal(url.searchParams.get("vnp_IpAddr"), "127.0.0.1");
});
test("VNPay rejects tampering, duplicate query fields and wrong merchant", () => {
  assert.equal(gateway.verify(signed(params)).success, true);
  assert.equal(gateway.verify({ ...signed(params), vnp_Amount: "100" }), null);
  assert.equal(gateway.verify({ ...signed(params), vnp_TxnRef: ["reference", "other"] }), null);
  assert.equal(gateway.verify(signed({ ...params, vnp_TmnCode: "OTHER123" })), null);
  assert.equal(gateway.verify(signed({ ...params, vnp_TransactionNo: "0" })), null);
  for (const status of ["01", "04", "05", "06", "07", "09"]) {
    assert.equal(gateway.verify(signed({ ...params, vnp_TransactionStatus: status })), null);
  }
  assert.equal(gateway.verify(signed({ ...params, vnp_ResponseCode: "24", vnp_TransactionStatus: "02", vnp_TransactionNo: "0" })).success, false);
  assert.equal(new VnpaySandboxGateway({ tmnCode: "", hashSecret: "", returnUrl: "" }).enabled(), false);
});
test("browser return never writes; only verified IPN calls repository", async () => {
  let writes = 0;
  const service = new PaymentsService({ confirm: async () => { writes++; return { RspCode: "00" }; } }, gateway);
  assert.equal(service.verifyReturn(signed(params)).verified, true);
  assert.equal(writes, 0);
  assert.equal((await service.ipn({ ...signed(params), vnp_Amount: "100" })).RspCode, "97");
  assert.equal(writes, 0);
  await service.ipn(signed(params));
  assert.equal(writes, 1);
  await assert.rejects(service.start({ sub: "staff", role: "staff" }, "invoice", "127.0.0.1"), { status: 403 });
});
test("querydr authenticates response and leaves nonterminal results unresolved", async () => {
  const original = globalThis.fetch;
  const fields = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode", "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType", "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"];
  let status = "00", tamper = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction");
    const request = JSON.parse(options.body);
    const requestString = [request.vnp_RequestId, "2.1.0", "querydr", "TESTCODE", "reference", "20300101080000", request.vnp_CreateDate, "127.0.0.1", "Kiem tra reference"].join("|");
    assert.equal(request.vnp_SecureHash, createHmac("sha512", secret).update(requestString).digest("hex"));
    const response = { ...params, vnp_ResponseId: "response", vnp_Command: "querydr", vnp_Message: "Success", vnp_BankCode: "NCB", vnp_PayDate: "20300101080100", vnp_TransactionType: "01", vnp_TransactionStatus: status, vnp_OrderInfo: "Test" };
    response.vnp_SecureHash = createHmac("sha512", secret).update(fields.map(key => response[key] ?? "").join("|")).digest("hex");
    if (tamper) response.vnp_Amount = "100";
    return { ok: true, json: async () => response };
  };
  try {
    assert.equal((await gateway.query(attempt, "127.0.0.1")).success, true);
    status = "01"; assert.equal(await gateway.query(attempt, "127.0.0.1"), null);
    status = "02"; assert.equal((await gateway.query(attempt, "127.0.0.1")).success, false);
    tamper = true; await assert.rejects(gateway.query(attempt, "127.0.0.1"), { status: 502 });
  } finally { globalThis.fetch = original; }
});
