import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";

const url = new URL(process.env.PG_TEST_DATABASE_URL || "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.ok(url.pathname.endsWith("_test"), "Only a disposable local *_test database is allowed");
process.env.JWT_SECRET = randomBytes(32).toString("hex");
const db = new PrismaClient({ datasources: { db: { url: url.href } } });
const marker = randomUUID();
const userIds = [];
let server;
let base;
async function start() {
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/invoices`;
}
async function close() { if (server) await new Promise(resolve => server.close(resolve)); }
async function request(token, method = "GET", body, suffix = "") {
  const result = await fetch(base + suffix, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: result.status, body: await result.json() };
}
try {
  const users = [];
  for (const role of ["owner", "owner", "staff"]) {
    const user = await db.user.create({ data: { role, fullName: marker, email: `${randomUUID()}@example.test`, passwordHash: "unused", passwordSalt: "unused" } });
    userIds.push(user.id); users.push(user);
  }
  const [owner, outsider, staff] = users;
  const tokens = users.map(user => signToken(user.id, user.role));
  const [ownerToken, outsiderToken, staffToken] = tokens;
  const pet = await db.pet.create({ data: { ownerId: owner.id, name: marker, species: "dog", allergies: [] } });
  const appointment = await db.appointment.create({ data: { ownerId: owner.id, petId: pet.id, type: "general_checkup", serviceName: "Invoice integration", clinicName: "Test", appointmentDate: new Date("2031-01-01"), appointmentTime: "10:00", status: "completed" } });
  const booking = await db.hotelBooking.create({ data: { ownerId: owner.id, petId: pet.id, checkIn: new Date("2031-01-01"), checkOut: new Date("2031-01-03"), nights: 2, roomType: "standard", serviceKeys: [], totalAmount: 6000, status: "checked_out" } });
  await start();
  const input = { type: "appointment", relatedId: appointment.id, subtotal: 250000, taxAmount: 20000, discountAmount: 10000, ownerId: outsider.id, totalAmount: 1, paymentStatus: "paid" };
  assert.equal((await request(null, "POST", input)).status, 401);
  assert.equal((await request(ownerToken, "POST", input)).status, 403);
  assert.equal((await request(staffToken, "POST", { ...input, subtotal: -1 })).status, 422);
  assert.equal((await request(staffToken, "POST", { ...input, relatedId: "missing" })).status, 404);
  await db.appointment.update({ where: { id: appointment.id }, data: { status: "pending" } });
  assert.equal((await request(staffToken, "POST", input)).status, 409);
  await db.appointment.update({ where: { id: appointment.id }, data: { status: "completed" } });
  const issues = await Promise.all(Array.from({ length: 8 }, () => request(staffToken, "POST", input)));
  assert.equal(issues.filter(r => r.status === 201).length, 1);
  assert.equal(issues.filter(r => r.status === 409).length, 7);
  const invoice = issues.find(r => r.status === 201).body.invoice;
  assert.equal(invoice.ownerId, owner.id);
  assert.equal(invoice.totalAmount, 260000);
  assert.equal(invoice.paymentStatus, "unpaid");
  assert.equal(invoice.items[0].unitPrice, 250000);
  assert.equal(typeof invoice.items[0].amount, "number");
  assert.equal(await db.invoice.count({ where: { appointmentId: appointment.id } }), 1);
  assert.equal((await request(ownerToken, "PATCH", { paymentMethod: "cash" }, `/${invoice.id}/pay`)).status, 403);
  assert.equal((await request(staffToken, "PATCH", { paymentMethod: "invalid" }, `/${invoice.id}/pay`)).status, 422);
  assert.equal((await request(staffToken, "PATCH", {}, "/missing/pay")).status, 404);
  const competing = await Promise.all(["cash", "bank_transfer"].map(paymentMethod => request(staffToken, "PATCH", { paymentMethod }, `/${invoice.id}/pay`)));
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  const paid = competing.find(r => r.status === 200).body.invoice;
  const retries = await Promise.all(Array.from({ length: 8 }, () => request(staffToken, "PATCH", { paymentMethod: paid.paymentMethod }, `/${invoice.id}/pay`)));
  assert.ok(retries.every(r => r.status === 200 && r.body.invoice.paidAt === paid.paidAt));
  const persisted = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  assert.equal(persisted.paymentStatus, "paid");
  assert.equal(persisted.paidAt.toISOString(), paid.paidAt);
  assert.equal(persisted.paymentMethod, paid.paymentMethod);
  assert.equal(Number(persisted.totalAmount), 260000);
  assert.equal((await request(ownerToken, "GET", undefined, `/${invoice.id}/payment-history`)).status, 403);
  const paymentHistory = await request(staffToken, "GET", undefined, `/${invoice.id}/payment-history`);
  assert.equal(paymentHistory.status, 200);
  assert.equal(paymentHistory.body.length, 1, "Repeated confirmation must not create another receipt");
  assert.equal(paymentHistory.body[0].action, "payment_confirmed");
  assert.equal(paymentHistory.body[0].actorId, staff.id);
  await close(); await start();
  assert.equal((await request(staffToken)).body.items.find(i => i.id === invoice.id).paidAt, paid.paidAt);
  assert.equal((await request(ownerToken)).body.items.length, 1);
  assert.equal((await request(outsiderToken)).body.items.length, 0);
  assert.equal((await request(outsiderToken, "GET", undefined, `?ownerId=${owner.id}`)).body.items.length, 0);
  assert.equal((await request(staffToken, "POST", { type: "hotel_booking", relatedId: booking.id, subtotal: 1 })).status, 422);
  const hotel = await request(staffToken, "POST", { type: "hotel_booking", relatedId: booking.id });
  assert.equal(hotel.status, 201);
  assert.equal(hotel.body.invoice.totalAmount, 6000);
  await db.invoice.update({ where: { id: hotel.body.invoice.id }, data: { paymentStatus: "refunded" } });
  assert.equal((await request(staffToken, "PATCH", { paymentMethod: "cash" }, `/${hotel.body.invoice.id}/pay`)).status, 409);
  assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: hotel.body.invoice.id } })).paymentStatus, "refunded");
  console.log("Invoice integration PASS: issuance/amounts/ownership, unique source under 8 concurrent requests, competing payments, idempotent retries, DB persistence + API restart, hotel stored total, refunded conflict.");
} finally {
  await close();
  await db.invoice.deleteMany({ where: { ownerId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
}
