import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";
import { signVnpay } from "../dist/src/infrastructure/security/vnpay.js";

const url = new URL(process.env.PG_TEST_DATABASE_URL || "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.ok(url.pathname.endsWith("_test"), "Only disposable local *_test databases");
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.VNPAY_TMN_CODE = "TESTCODE";
process.env.VNPAY_ENABLED = "true";
process.env.VNPAY_HASH_SECRET = randomBytes(32).toString("hex");
process.env.VNPAY_RETURN_URL = "http://localhost:5173/owner/billing";
const db = new PrismaClient({ datasources: { db: { url: url.href } } });
const userIds = [];
let server, base;
const notices = [];
async function req(path, token, method = "GET", body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
function callback(reference, overrides = {}) {
  const data = { vnp_TmnCode: "TESTCODE", vnp_TxnRef: reference, vnp_Amount: "25000000", vnp_ResponseCode: "00", vnp_TransactionStatus: "00", vnp_TransactionNo: "123456789", ...overrides };
  return new URLSearchParams({ ...data, vnp_SecureHash: signVnpay(data, process.env.VNPAY_HASH_SECRET) }).toString();
}
const ipn = query => req("/payments/vnpay/ipn?" + query);
try {
  const users = [];
  for (const role of ["owner", "owner", "staff"]) {
    const user = await db.user.create({ data: { role, fullName: "VNPay integration", email: `${randomUUID()}@example.test`, passwordHash: "unused", passwordSalt: "unused" } });
    users.push(user); userIds.push(user.id);
  }
  const [owner, outsider, staff] = users;
  const [ownerToken, otherToken, staffToken] = users.map(u => signToken(u.id, u.role));
  const pet = await db.pet.create({ data: { ownerId: owner.id, name: "Test", species: "dog", allergies: [] } });
  let serial = 0;
  const appointment = type => db.appointment.create({ data: { ownerId: owner.id, petId: pet.id, type, serviceName: type,
    clinicName: "Test", appointmentDate: new Date(Date.UTC(2035, 0, ++serial)), appointmentTime: "10:00", status: "completed" } });
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await req("/payments/options", ownerToken)).body.vnpayEnabled, true);
  const spa = await appointment("spa_bath"), exam = await appointment("general_checkup");
  const checkout = { type: "appointment", relatedId: spa.id };
  assert.equal((await req("/invoices/checkout", otherToken, "POST", checkout)).status, 404);
  assert.equal((await req("/invoices/checkout", staffToken, "POST", checkout)).status, 403);
  assert.equal((await req("/invoices/checkout", ownerToken, "POST", { ...checkout, totalAmount: 1 })).status, 422);
  assert.equal((await req("/invoices/checkout", ownerToken, "POST", { ...checkout, relatedId: exam.id })).status, 409);
  const invoice = (await req("/invoices/checkout", ownerToken, "POST", checkout)).body.invoice;
  assert.equal(invoice.totalAmount, 250000);
  assert.equal((await req("/invoices/checkout", ownerToken, "POST", checkout)).body.invoice.id, invoice.id);
  const detailed = await req("/invoices", staffToken, "POST", { type: "appointment", relatedId: exam.id,
    items: [{ description: "Khám", quantity: 1, unitPrice: 250000 }, { description: "Xét nghiệm", quantity: 2, unitPrice: 100000 }],
    taxAmount: 20000, discountAmount: 10000, totalAmount: 1, ownerId: outsider.id });
  assert.equal(detailed.status, 201);
  assert.equal(detailed.body.invoice.totalAmount, 460000);
  assert.equal(detailed.body.invoice.items.length, 2);
  assert.equal(detailed.body.invoice.ownerId, owner.id);
  assert.equal((await req(`/invoices/${invoice.id}/onsite`, otherToken, "PATCH")).status, 404);
  assert.equal((await req(`/invoices/${invoice.id}/onsite`, ownerToken, "PATCH")).body.invoice.paymentStatus, "unpaid");
  assert.equal((await req(`/payments/${invoice.id}/vnpay`, otherToken, "POST")).status, 404);
  assert.equal((await req(`/payments/${invoice.id}/vnpay`, staffToken, "POST")).status, 403);
  assert.equal((await req(`/payments/${invoice.id}/reconcile`, otherToken, "POST")).status, 404);
  const attempts = await Promise.all(Array.from({ length: 6 }, () => req(`/payments/${invoice.id}/vnpay`, ownerToken, "POST", { amount: 1 })));
  assert.ok(attempts.every(r => r.status === 200));
  assert.equal(new Set(attempts.map(r => r.body.reference)).size, 1);
  const reference = attempts[0].body.reference;
  assert.equal(new URL(attempts[0].body.paymentUrl).searchParams.get("vnp_Amount"), "25000000");
  assert.equal(await db.paymentAttempt.count({ where: { invoiceId: invoice.id } }), 1);
  assert.equal((await req(`/invoices/${invoice.id}/onsite`, ownerToken, "PATCH")).status, 409);
  assert.equal((await req(`/invoices/${invoice.id}/pay`, staffToken, "PATCH", { paymentMethod: "cash" })).status, 409);
  assert.equal((await req("/payments/vnpay/return?" + callback(reference))).body.verified, true);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).paymentStatus, "unpaid");
  assert.equal((await ipn(callback(reference).replace("vnp_Amount=25000000", "vnp_Amount=100"))).body.RspCode, "97");
  assert.equal((await ipn(callback(reference, { vnp_Amount: "100" }))).body.RspCode, "04");
  assert.equal((await ipn(callback("missing"))).body.RspCode, "01");
  assert.equal((await ipn(callback(reference, { vnp_TmnCode: "OTHER123" }))).body.RspCode, "97");
  assert.equal((await ipn(callback(reference, { vnp_ResponseCode: "24", vnp_TransactionStatus: "02", vnp_TransactionNo: "0" }))).body.RspCode, "00");
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).paymentStatus, "unpaid");
  assert.equal((await req(`/invoices/${invoice.id}/onsite`, ownerToken, "PATCH")).status, 200);
  const next = (await req(`/payments/${invoice.id}/vnpay`, ownerToken, "POST")).body.reference;
  assert.notEqual(next, reference);
  await db.paymentAttempt.update({ where: { id: next }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await req(`/payments/${invoice.id}/vnpay`, ownerToken, "POST")).status, 409);
  assert.equal((await req(`/invoices/${invoice.id}/onsite`, ownerToken, "PATCH")).status, 409);
  const results = await Promise.all(Array.from({ length: 6 }, () => ipn(callback(next))));
  assert.equal(results.filter(r => r.body.RspCode === "00").length, 1);
  assert.equal(results.filter(r => r.body.RspCode === "02").length, 5);
  const paid = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  assert.equal(paid.paymentStatus, "paid"); assert.equal(paid.paymentMethod, "vnpay");
  assert.ok(paid.paidAt);
  assert.equal(await db.notification.count({ where: { recipientOwnerId: owner.id, type: "invoice_paid" } }), 1);
  // A contradictory late success must be flagged, never silently discarded or charged again.
  assert.equal((await ipn(callback(reference, { vnp_TransactionNo: "123456790" }))).body.RspCode, "00");
  assert.equal((await db.paymentAttempt.findUniqueOrThrow({ where: { id: reference } })).status, "review");
  const notice = await db.notification.findFirstOrThrow({ where: { type: "payment_review", message: { contains: reference } } });
  notices.push(notice.id);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).paidAt.toISOString(), paid.paidAt.toISOString());
  assert.equal((await req("/invoices", otherToken)).body.length, 0);
  // Hotel checkout uses the stored base even if the current catalog changes.
  const booking = await db.hotelBooking.create({ data: { ownerId: owner.id, petId: pet.id, checkIn: new Date("2035-01-01"), checkOut: new Date("2035-01-03"), nights: 2, roomType: "standard", serviceKeys: [], totalAmount: 700000, status: "checked_out" } });
  assert.equal((await req("/invoices/checkout", ownerToken, "POST", { type: "hotel_booking", relatedId: booking.id })).status, 403);
  const hotel = (await req("/invoices", staffToken, "POST", { type: "hotel_booking", relatedId: booking.id })).body.invoice;
  assert.equal(hotel.totalAmount, 700000);
  const late = (await req(`/payments/${hotel.id}/vnpay`, ownerToken, "POST")).body.reference;
  assert.equal((await ipn(callback(late, { vnp_Amount: "70000000", vnp_ResponseCode: "24", vnp_TransactionStatus: "02", vnp_TransactionNo: "0" }))).body.RspCode, "00");
  assert.equal((await req(`/invoices/${hotel.id}/onsite`, ownerToken, "PATCH")).status, 200);
  assert.equal((await ipn(callback(late, { vnp_Amount: "70000000", vnp_TransactionNo: "123456791" }))).body.RspCode, "00");
  const lateNotice = await db.notification.findFirstOrThrow({ where: { type: "payment_review", message: { contains: late } } });
  notices.push(lateNotice.id);
  assert.equal((await req(`/invoices/${hotel.id}/pay`, staffToken, "PATCH", { paymentMethod: "cash" })).status, 409);
  assert.equal((await req(`/payments/${hotel.id}/vnpay`, ownerToken, "POST")).status, 409);
  console.log("VNPay integration PASS: itemized charges, fixed checkout, ownership, onsite, concurrent attempts, signed callbacks, amount/merchant checks, browser return read-only, failed retry, pending expiry lock, concurrent IPN exactly once, late success review, stored hotel price.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.notification.deleteMany({ where: { id: { in: notices } } });
  await db.invoice.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
}
