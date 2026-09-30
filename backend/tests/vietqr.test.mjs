import assert from "node:assert/strict";
import test from "node:test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { QRPay } from "vietnam-qr-pay";
import { VietQrGenerator } from "../dist/src/infrastructure/payments/vietqr.js";
import { InvoicesService } from "../dist/src/application/services/invoices.js";

const generator = new VietQrGenerator();
const details = { isDemo: false, bankBin: "970416", accountNumber: "257678859" };
test("rendered PNG decodes to the published dynamic VietQR vector", async () => {
  const url = await generator.generate(details, 10000, "CHUYENTIEN");
  const png = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded, "A scanner must read the actual PNG");
  const qr = new QRPay(decoded.data);
  assert.equal(qr.isValid, true);
  assert.equal(qr.consumer.bankBin, "970416");
  assert.equal(qr.consumer.bankNumber, "257678859");
  assert.equal(qr.amount, "10000");
  assert.equal(qr.currency, "704");
  assert.equal(qr.nation, "VN");
  assert.equal(qr.additionalData.purpose, "CHUYENTIEN");
  // Published upstream dynamic example (including CRC), independent expected vector.
  assert.equal(QRPay.initVietQR({ bankBin: "970416", bankNumber: "257678859", amount: "10000", purpose: "Chuyen tien" }).build(),
    "00020101021238530010A0000007270123000697041601092576788590208QRIBFTTA53037045405100005802VN62150811Chuyen tien630453E6");
});
test("QR rejects demo destinations, malformed snapshots, ambiguous content and invalid VND amounts", async () => {
  for (const bad of [null, {}, { ...details, isDemo: true }, { ...details, bankBin: "97043x" }, { ...details, accountNumber: "123abc" }])
    await assert.rejects(generator.generate(bad, 250000, "NIPO0000000001"), { status: 409 });
  for (const value of [0, -1, 0.5, NaN, Infinity, 10000000000])
    await assert.rejects(generator.generate(details, value, "NIPO0000000001"), { status: 409 });
  for (const content of ["", "a".repeat(26), "NIPO 1", "Chuyển tiền", "a&amount=1"])
    await assert.rejects(generator.generate(details, 250000, content), { status: 409 });
});
test("QR service scopes owner lookup and blocks settled or reported invoices", async () => {
  const seen = [];
  let invoice = { invoiceCode: "INV-old", transferCode: "NIPO0000000001", paymentStatus: "unpaid", paymentChannel: "bank_transfer", totalAmount: "250000", bankTransferDetails: details };
  const service = new InvoicesService({ find: async (...args) => { seen.push(args); return invoice; } }, null,
    { generate: async (...args) => { seen.push(args); return "data:image/png;base64,test"; } });
  const owner = { role: "owner", sub: "owner-a" };
  await service.transferQr(owner, "invoice-a");
  assert.deepEqual(seen[0], ["invoice-a", "owner-a"]);
  assert.deepEqual(seen[1], [details, 250000, "NIPO0000000001"]);
  for (const state of [{ paymentStatus: "paid" }, { paymentStatus: "refunded" }, { transferReviewStatus: "pending" }, { paymentChannel: "onsite" }]) {
    const original = invoice; invoice = { ...invoice, ...state };
    await assert.rejects(service.transferQr(owner, "invoice-a"), { status: 409 }); invoice = original;
  }
  invoice = null;
  await assert.rejects(service.transferQr(owner, "invoice-a"), { status: 404 });
});
