import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";

const url = new URL(process.env.PG_TEST_DATABASE_URL || "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.ok(url.pathname.endsWith("_test"), "Only a disposable local *_test database");
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.BANK_TRANSFER_DEMO = "true";
delete process.env.VNPAY_ENABLED;
process.env.VNPAY_TMN_CODE = "TESTCODE";
process.env.VNPAY_HASH_SECRET = "synthetic-unused-key-only";
process.env.VNPAY_RETURN_URL = "http://localhost:5173/owner/billing";
const db = new PrismaClient({ datasources: { db: { url: url.href } } });
const users = [], codes = [];
let server, base;
async function start() {
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
async function stop() { if (server) await new Promise(resolve => server.close(resolve)); }
async function req(path, token, method = "GET", data) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: res.status, body: await res.json() };
}
try {
  for (const role of ["owner", "owner", "staff"]) users.push(await db.user.create({ data: {
    role, fullName: "Manual transfer test", email: `${randomUUID()}@example.test`, passwordHash: "unused", passwordSalt: "unused",
  } }));
  const [owner, outsider, staff] = users;
  const [ownerToken, otherToken, staffToken] = users.map(u => signToken(u.id, u.role));
  const pet = await db.pet.create({ data: { ownerId: owner.id, name: "Test", species: "dog", allergies: [] } });
  const appointment = await db.appointment.create({ data: { ownerId: owner.id, petId: pet.id, type: "spa_bath",
    serviceName: "Manual transfer test", clinicName: "Test", appointmentDate: new Date("2036-01-01"), appointmentTime: "10:00", status: "completed" } });
  await start();
  const options = await req("/payments/options", ownerToken);
  assert.equal(options.body.vnpayEnabled, false, "Phase 1 disables VNPay even with merchant-shaped config");
  assert.equal(options.body.bankTransfer.isDemo, true);
  const invoice = (await req("/invoices/checkout", ownerToken, "POST", { type: "appointment", relatedId: appointment.id })).body.invoice;
  codes.push(invoice.invoiceCode);
  const path = `/invoices/${invoice.id}`;
  assert.equal((await req(`/payments/${invoice.id}/vnpay`, ownerToken, "POST")).status, 409);
  assert.equal((await req(path + "/bank-transfer", null, "PATCH")).status, 401);
  assert.equal((await req(path + "/bank-transfer", otherToken, "PATCH")).status, 404);
  assert.equal((await req(path + "/bank-transfer", staffToken, "PATCH")).status, 403);
  assert.equal((await req(path + "/transfer-report", ownerToken, "POST", {})).status, 409);
  const selected = (await req(path + "/bank-transfer", ownerToken, "PATCH", { accountNumber: "forged", totalAmount: 1 })).body.invoice;
  assert.equal(selected.bankTransferDetails.accountNumber, "0000000000");
  assert.equal(selected.totalAmount, 250000);
  assert.equal(selected.paymentStatus, "unpaid");
  assert.equal((await req(path + "/transfer-report", otherToken, "POST", {})).status, 404);
  assert.equal((await req(path + "/transfer-report", ownerToken, "POST", { reference: "a".repeat(101) })).status, 422);
  const reports = await Promise.all(Array.from({ length: 6 }, () => req(path + "/transfer-report", ownerToken, "POST", { reference: "DEMO-TXN" })));
  assert.ok(reports.every(r => r.status === 200 && r.body.invoice.paymentStatus === "unpaid"));
  assert.equal(new Set(reports.map(r => r.body.invoice.transferReportedAt)).size, 1);
  assert.equal(await db.notification.count({ where: { type: "transfer_reported", message: { contains: invoice.invoiceCode } } }), 1);
  assert.equal((await req(path + "/onsite", ownerToken, "PATCH")).status, 409);
  assert.equal((await req(path + "/pay", ownerToken, "PATCH", { paymentMethod: "bank_transfer" })).status, 403);
  assert.equal((await req(path + "/pay", staffToken, "PATCH", { paymentMethod: "cash" })).status, 409);
  assert.equal((await req(path + "/transfer-reject", ownerToken, "POST", { reason: "forged" })).status, 403);
  assert.equal((await req(path + "/transfer-reject", staffToken, "POST", { reason: "" })).status, 422);
  const rejected = await req(path + "/transfer-reject", staffToken, "POST", { reason: "Chưa thấy giao dịch, vui lòng kiểm tra mã." });
  assert.equal(rejected.body.invoice.transferReviewStatus, "rejected");
  assert.equal(rejected.body.invoice.paymentStatus, "unpaid");
  assert.equal((await req(path + "/transfer-reject", staffToken, "POST", { reason: "again" })).status, 409);
  // Restart with a different configured destination; existing invoice must keep its displayed recipient.
  await stop();
  process.env.BANK_TRANSFER_DEMO = "false";
  process.env.BANK_TRANSFER_BANK_NAME = "Test changed bank";
  process.env.BANK_TRANSFER_BANK_BIN = "970436";
  process.env.BANK_TRANSFER_ACCOUNT_NUMBER = "123456789";
  process.env.BANK_TRANSFER_ACCOUNT_HOLDER = "TEST ONLY";
  await start();
  assert.equal((await req(path + "/onsite", ownerToken, "PATCH")).status, 200);
  const unchanged = (await req(path + "/bank-transfer", ownerToken, "PATCH")).body.invoice;
  assert.equal(unchanged.bankTransferDetails.accountNumber, "0000000000");
  assert.equal(unchanged.bankTransferDetails.isDemo, true);
  const resubmitted = (await req(path + "/transfer-report", ownerToken, "POST", { reference: "DEMO-CORRECTED" })).body.invoice;
  assert.equal(resubmitted.transferReviewStatus, "pending");
  assert.equal(resubmitted.transferReviewNote, null);
  const payments = await Promise.all(Array.from({ length: 6 }, () => req(path + "/pay", staffToken, "PATCH", { paymentMethod: "bank_transfer" })));
  assert.ok(payments.every(r => r.status === 200 && r.body.invoice.paymentStatus === "paid"));
  assert.equal(new Set(payments.map(r => r.body.invoice.paidAt)).size, 1);
  const paid = payments[0].body.invoice;
  assert.equal(paid.paymentChannel, "bank_transfer");
  assert.equal(paid.transferReviewStatus, "confirmed");
  assert.equal(await db.notification.count({ where: { recipientOwnerId: owner.id, type: "invoice_paid" } }), 1);
  const audit = await req(path + "/payment-history", staffToken);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.length, 4);
  assert.equal(audit.body.filter(event => event.action === "transfer_reported" && event.actorId === owner.id).length, 2);
  assert.equal(audit.body.filter(event => event.action === "transfer_rejected" && event.actorId === staff.id && event.reason).length, 1);
  assert.equal(audit.body.filter(event => event.action === "payment_confirmed" && event.actorId === staff.id).length, 1);
  assert.equal((await req(path + "/payment-history", ownerToken)).status, 403);
  assert.equal((await req(path + "/transfer-report", ownerToken, "POST", {})).status, 409);
  assert.equal((await req(path + "/transfer-reject", staffToken, "POST", { reason: "late" })).status, 409);
  await stop(); await start();
  const stored = (await req("/invoices", ownerToken)).body.find(i => i.id === invoice.id);
  assert.equal(stored.paidAt, paid.paidAt);
  assert.equal(stored.transferReference, "DEMO-CORRECTED");
  assert.equal((await req("/invoices", otherToken)).body.length, 0);
  console.log("Manual bank transfer integration PASS: Phase 1 gate, recipient snapshot, ownership, report remains unpaid, repeated/concurrent reporting, rejection/resubmission, pending switch lock, staff confirmation exactly once, persistence after API restart.");
} finally {
  await stop();
  if (codes.length) await db.notification.deleteMany({ where: { OR: codes.map(code => ({ message: { contains: code } })) } });
  await db.invoice.deleteMany({ where: { ownerId: { in: users.map(u => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } });
  await db.$disconnect();
}
