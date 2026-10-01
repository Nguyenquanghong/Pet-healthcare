import assert from "node:assert/strict";
import { randomBytes, randomUUID, randomInt } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";

const rawUrl = process.env.PG_TEST_DATABASE_URL;
assert.ok(rawUrl, "Use a disposable local PostgreSQL database named *_test.");
const url = new URL(rawUrl);
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && decodeURIComponent(url.pathname).endsWith("_test"));
process.env.JWT_SECRET = randomBytes(32).toString("hex");
const db = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const users = [], bookingIds = [], appointmentIds = [];
let server, base;
async function request(token, method, path, body, key) {
  const res = await fetch(base + path, { method, headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    ...(key ? { "Idempotency-Key": key } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
try {
  for (const role of ["owner", "owner", "admin", "staff"]) users.push(await db.user.create({ data: {
    role, fullName: `Reception ${role}`, email: `${randomUUID()}@example.test`,
    passwordHash: "unused", passwordSalt: "unused",
  } }));
  const [owner, outsider, admin, staff] = users;
  const [ownerToken, outsiderToken, adminToken, staffToken] = users.map(user => signToken(user.id, user.role));
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  const customerInput = { fullName: "Khách mới tại quầy", phone: `09${randomInt(100_000_000).toString().padStart(8, "0")}`, role: "admin", password: "do-not-grant-login" };
  assert.equal((await fetch(base + "/owners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(customerInput) })).status, 401);
  assert.equal((await request(ownerToken, "POST", "/owners", customerInput)).status, 403);
  assert.equal((await request(signToken("doctor-id", "doctor"), "POST", "/owners", customerInput)).status, 403);
  const customerReply = await request(staffToken, "POST", "/owners", customerInput);
  assert.equal(customerReply.status, 201, JSON.stringify(customerReply.body));
  const customer = customerReply.body.owner;
  users.push(customer);
  assert.equal(customer.role, "owner");
  assert.deepEqual(customer.petIds, []);
  assert.equal(customerReply.body.token, undefined);
  assert.equal(customer.passwordHash, undefined);
  assert.equal(customer.passwordSalt, undefined);
  const storedCustomer = await db.user.findUnique({ where: { id: customer.id } });
  assert.equal(storedCustomer.email, null);
  assert.equal(storedCustomer.passwordHash, "");
  assert.equal(storedCustomer.passwordSalt, "");
  assert.equal((await request(adminToken, "POST", "/owners", { ...customerInput, phone: `+84 ${customer.phone.slice(1)}` })).status, 409);
  const email = `${randomUUID()}@example.test`;
  const concurrentPhone = `09${randomInt(100_000_000).toString().padStart(8, "0")}`;
  const concurrentCustomers = await Promise.all([adminToken, staffToken].map(token => request(token, "POST", "/owners", { fullName: "Khách đồng thời", phone: concurrentPhone, email })));
  for (const result of concurrentCustomers) if (result.status === 201) users.push(result.body.owner);
  assert.deepEqual(concurrentCustomers.map(item => item.status).sort(), [201, 409]);
  const onlineAttempt = await request(adminToken, "POST", "/auth/owner/login", { email, password: "do-not-grant-login" });
  assert.equal(onlineAttempt.status, 401);
  assert.equal((await request(adminToken, "POST", "/owners", { fullName: "Khách trùng email", phone: `09${randomInt(100_000_000).toString().padStart(8, "0")}`, email: email.toUpperCase() })).status, 409);
  // A legacy profile with spaces/+84 is also found, without modifying its stored data.
  const legacyPhone = `09${randomInt(100_000_000).toString().padStart(8, "0")}`;
  await db.user.update({ where: { id: outsider.id }, data: { phone: `+84 ${legacyPhone.slice(1, 4)} ${legacyPhone.slice(4)}` } });
  assert.equal((await request(adminToken, "POST", "/owners", { fullName: "Khách trùng số cũ", phone: legacyPhone })).status, 409);
  const newPetReply = await request(staffToken, "POST", "/pets", { ownerId: customer.id, name: "Thú cưng mới tại quầy", species: "dog" });
  assert.equal(newPetReply.status, 201);
  assert.equal(newPetReply.body.pet.ownerId, customer.id);
  const counterHotel = await request(staffToken, "POST", "/hotel-bookings", { petId: newPetReply.body.pet.id, checkIn: "2098-01-01", checkOut: "2098-01-02", roomType: "standard", serviceKeys: [] }, randomUUID());
  assert.equal(counterHotel.status, 201);
  bookingIds.push(counterHotel.body.booking.id);
  assert.equal(counterHotel.body.booking.ownerId, customer.id);
  assert.equal(counterHotel.body.booking.status, "pending");
  assert.equal(await db.invoice.count({ where: { hotelBookingId: counterHotel.body.booking.id } }), 0);
  const customerBootstrap = await request(adminToken, "GET", "/bootstrap");
  assert.ok(customerBootstrap.body.owners.some(item => item.id === customer.id));
  const createPet = { ownerId: owner.id, name: "Reception pet", species: "cat", gender: "female", weightKg: 3.5 };
  for (const ownerId of ["missing-owner", admin.id, staff.id])
    assert.equal((await request(adminToken, "POST", "/pets", { ...createPet, ownerId })).status, 422, "Invalid owner is a business error, not an ORM failure");
  assert.equal(await db.pet.count({ where: { ownerId: admin.id } }), 0);
  const petReply = await request(adminToken, "POST", "/pets", createPet);
  assert.equal(petReply.status, 201);
  const pet = petReply.body.pet;
  assert.equal(pet.ownerId, owner.id);
  assert.equal(pet.weightKg, 3.5);
  assert.ok(pet.qrToken);
  const ownPet = await request(outsiderToken, "POST", "/pets", { ...createPet, name: "Outsider pet" });
  assert.equal(ownPet.status, 201);
  assert.equal(ownPet.body.pet.ownerId, outsider.id, "Owner identity comes from token even when ownerId is supplied");

  const appointmentInput = { petId: pet.id, type: "general_checkup", serviceName: "Khám tổng quát", date: "2098-01-01", time: "09:00", ownerId: outsider.id };
  const appointmentReply = await request(adminToken, "POST", "/appointments", appointmentInput);
  assert.equal(appointmentReply.status, 201);
  const appointment = appointmentReply.body.appointment;
  appointmentIds.push(appointment.id);
  assert.equal(appointment.ownerId, owner.id);
  assert.equal(appointment.createdBy, "staff");
  assert.equal(appointment.status, "pending");
  assert.equal((await request(adminToken, "POST", "/appointments", appointmentInput)).status, 409);
  assert.equal((await request(outsiderToken, "POST", "/appointments", { ...appointmentInput, time: "11:00" })).status, 403);
  const spaReply = await request(staffToken, "POST", "/appointments", { ...appointmentInput, type: "spa_bath", serviceName: "Tắm & sấy", time: "10:30" });
  assert.equal(spaReply.status, 201);
  appointmentIds.push(spaReply.body.appointment.id);
  assert.equal(spaReply.body.appointment.createdBy, "staff");

  // New entries continue through the existing audited lifecycle.
  let revision = 0;
  for (const status of ["confirmed", "checked_in"]) {
    const changed = await request(adminToken, "PATCH", `/appointments/${appointment.id}/status`, { status, expectedRevision: revision });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    revision = changed.body.appointment.statusRevision;
  }
  const undone = await request(adminToken, "POST", `/appointments/${appointment.id}/undo-status`, {
    expectedRevision: revision, reason: "Đối chiếu lại khách tại quầy",
  });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.appointment.status, "confirmed");
  const history = await request(adminToken, "GET", `/appointments/${appointment.id}/status-history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 3);
  assert.ok(history.body.every(event => event.actorId === admin.id));
  assert.ok(history.body.some(event => event.action === "undo" && event.reason === "Đối chiếu lại khách tại quầy"));

  const hotelInput = { petId: pet.id, checkIn: "2098-01-01", checkOut: "2098-01-03", roomType: "deluxe", serviceKeys: ["daily_walk"], totalAmount: 1, ownerId: outsider.id };
  const key = randomUUID();
  const hotelReply = await request(adminToken, "POST", "/hotel-bookings", hotelInput, key);
  assert.equal(hotelReply.status, 201, JSON.stringify(hotelReply.body));
  const booking = hotelReply.body.booking;
  bookingIds.push(booking.id);
  assert.equal(booking.ownerId, owner.id);
  assert.equal(booking.totalAmount, 1_320_000, "Backend computes price; an admin cannot inject a fake total");
  assert.equal(booking.status, "pending");
  assert.equal((await request(adminToken, "POST", "/hotel-bookings", hotelInput, key)).body.booking.id, booking.id);
  assert.equal((await request(staffToken, "POST", "/hotel-bookings", hotelInput, randomUUID())).status, 409, "Overlap is blocked across staff accounts");
  assert.equal((await request(outsiderToken, "POST", "/hotel-bookings", hotelInput, randomUUID())).status, 403);
  assert.equal(await db.invoice.count({ where: { hotelBookingId: booking.id } }), 0, "No invoice or collection at initial booking");
  const creation = await db.hotelBookingRequest.findFirst({ where: { bookingId: booking.id } });
  assert.equal(creation.actorId, admin.id, "Creation request preserves the staff identity");
  revision = 0;
  for (const status of ["confirmed", "in_stay"]) {
    const changed = await request(adminToken, "PATCH", `/hotel-bookings/${booking.id}/status`, { status, expectedRevision: revision });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    revision = changed.body.booking.statusRevision;
  }
  assert.equal((await request(adminToken, "PATCH", `/hotel-bookings/${booking.id}/status`, { status: "checked_out", expectedRevision: revision })).status, 409, "Unpaid hotel booking cannot check out");
  assert.equal((await request(ownerToken, "GET", `/hotel-bookings/${booking.id}`)).status, 200);
  assert.equal((await request(outsiderToken, "GET", `/hotel-bookings/${booking.id}`)).status, 404);
  console.log("Admin creation integration PASS: walk-in customer without login, 401/403, normalized/duplicate contacts, concurrent 201+409, new customer+pet+hotel, existing-owner validation, medical/spa/hotel creation, pricing, retry/overlap, lifecycle history/undo and unpaid checkout guard.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (users.length) {
    const userIds = users.map(user => user.id);
    const pets = await db.pet.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    await db.notification.deleteMany({ where: { relatedPetId: { in: pets.map(pet => pet.id) } } });
    // Events have a self-reference for undo: remove reversal entries first.
    const where = { bookingId: { in: [...bookingIds, ...appointmentIds] } };
    await db.bookingStatusEvent.deleteMany({ where: { ...where, reversesId: { not: null } } });
    await db.bookingStatusEvent.deleteMany({ where });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}
