import assert from "node:assert/strict";
import { randomBytes, randomUUID, randomInt, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken, verifyToken } from "../dist/src/lib/token.js";
import { verifyPassword } from "../dist/src/lib/password.js";

const rawUrl = process.env.PG_TEST_DATABASE_URL;
assert.ok(rawUrl, "Use a disposable local database named *_test.");
const url = new URL(rawUrl);
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && decodeURIComponent(url.pathname).endsWith("_test"));
process.env.JWT_SECRET = randomBytes(32).toString("hex");
const db = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const userIds = [];
let server, base;
async function request(token, path, body, method = "POST") {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
const digest = token => createHash("sha256").update(token).digest("hex");
const activationBody = (token, password = "CustomerSecure123") => ({ token, password, confirmPassword: password });
try {
  const staff = await db.user.create({ data: { role: "staff", fullName: "Activation staff", email: `${randomUUID()}@example.test`, passwordHash: "unused", passwordSalt: "unused" } });
  const active = await db.user.create({ data: { role: "owner", fullName: "Already online", email: `${randomUUID()}@example.test`, passwordHash: "unchanged", passwordSalt: "unchanged" } });
  userIds.push(staff.id, active.id);
  const staffToken = signToken(staff.id, "staff"), ownerToken = signToken(active.id, "owner");
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
  async function guest() {
    const result = await request(staffToken, "/owners", { fullName: "Khách kích hoạt", phone: `09${randomInt(100_000_000).toString().padStart(8, "0")}` });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    userIds.push(result.body.owner.id);
    assert.equal(result.body.owner.loginEnabled, false);
    return result.body.owner;
  }
  async function issue(owner, email = `${randomUUID()}@example.test`) {
    const result = await request(staffToken, `/owners/${owner.id}/activation`, { email, customerVerified: true });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.cache, "no-store");
    return result.body.activation;
  }

  const customer = await guest();
  const path = `/owners/${customer.id}/activation`, email = `${randomUUID()}@example.test`;
  const input = { email, customerVerified: true };
  assert.equal((await request(null, path, input)).status, 401);
  assert.equal((await request(ownerToken, path, input)).status, 403);
  assert.equal((await request(signToken("doctor", "doctor"), path, input)).status, 403);
  assert.equal((await request(staffToken, path, { email })).status, 422);
  assert.equal((await request(staffToken, path, { ...input, email: "bad" })).status, 422);
  assert.equal((await request(staffToken, "/owners/missing/activation", input)).status, 404);
  assert.equal((await request(staffToken, `/owners/${staff.id}/activation`, input)).status, 422);
  assert.equal((await request(staffToken, `/owners/${active.id}/activation`, input)).status, 409);
  assert.equal((await request(staffToken, path, { ...input, email: active.email.toUpperCase() })).status, 409);

  // Establish real records before activation. They must retain their original IDs and owner.
  const pet = await db.pet.create({ data: { ownerId: customer.id, name: "Existing counter pet", species: "cat", allergies: [] } });
  const appointment = await db.appointment.create({ data: { petId: pet.id, ownerId: customer.id, type: "general_checkup", serviceName: "Existing service", clinicName: "Test", appointmentDate: new Date("2098-01-01"), appointmentTime: "10:00", status: "completed" } });
  const medical = await db.medicalRecord.create({ data: { petId: pet.id, ownerId: customer.id, appointmentId: appointment.id, doctorName: "Test doctor", visitDate: new Date("2098-01-01"), title: "Existing record", diagnosis: "Test", treatment: "Test" } });
  const booking = await db.hotelBooking.create({ data: { petId: pet.id, ownerId: customer.id, checkIn: new Date("2098-01-03"), checkOut: new Date("2098-01-04"), roomType: "standard", nights: 1, serviceKeys: [], totalAmount: 300000 } });
  const invoiced = await request(staffToken, "/invoices", { type: "appointment", relatedId: appointment.id, subtotal: 250000 });
  assert.equal(invoiced.status, 201, JSON.stringify(invoiced.body));

  const first = await issue(customer, email.toUpperCase());
  const stored = await db.ownerActivation.findUniqueOrThrow({ where: { tokenHash: digest(first.token) } });
  assert.equal(stored.ownerId, customer.id);
  assert.equal(stored.issuedBy, staff.id);
  assert.equal(stored.issuedByName, staff.fullName);
  assert.equal(stored.email, email);
  assert.equal(stored.expiresAt - stored.createdAt, 30 * 60_000);
  assert.equal(stored.token, undefined);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: customer.id } })).email, null);
  assert.equal((await request(null, "/auth/owner/login", { email, password: "CustomerSecure123" })).status, 401);
  const inspected = await request(null, "/auth/owner/activation/inspect", { token: first.token });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.cache, "no-store");
  assert.deepEqual(Object.keys(inspected.body).sort(), ["email", "expiresAt"]);
  assert.equal((await request(null, "/auth/owner/activation", { token: first.token, password: "short", confirmPassword: "short" })).status, 422);
  assert.equal((await request(null, "/auth/owner/activation", { token: first.token, password: "CustomerSecure123", confirmPassword: "different" })).status, 422);

  const second = await issue(customer, email);
  assert.ok((await db.ownerActivation.findUniqueOrThrow({ where: { id: stored.id } })).revokedAt);
  assert.equal((await request(null, "/auth/owner/activation", activationBody(first.token))).status, 422);
  const consumed = await Promise.all(["FirstPassword123", "SecondPassword123"].map(password => request(null, "/auth/owner/activation", { ...activationBody(second.token, password), ownerId: active.id, role: "admin" })));
  assert.deepEqual(consumed.map(item => item.status).sort(), [200, 422]);
  const winner = consumed.findIndex(item => item.status === 200), password = ["FirstPassword123", "SecondPassword123"][winner];
  assert.equal(consumed[winner].cache, "no-store");
  assert.equal(consumed[winner].body.token, undefined);
  const activated = await db.user.findUniqueOrThrow({ where: { id: customer.id } });
  assert.equal(activated.role, "owner");
  assert.equal(activated.email, email);
  assert.ok(verifyPassword(password, activated.passwordHash, activated.passwordSalt));
  assert.notEqual(activated.passwordHash, password);
  assert.ok((await db.ownerActivation.findUniqueOrThrow({ where: { tokenHash: digest(second.token) } })).usedAt);
  assert.equal((await request(null, "/auth/owner/activation/inspect", { token: second.token })).status, 422);
  assert.equal((await request(null, "/auth/owner/activation", activationBody(second.token))).status, 422);
  assert.equal((await request(staffToken, path, input)).status, 409);
  const login = await request(null, "/auth/owner/login", { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(verifyToken(login.body.token).sub, customer.id);
  const bootstrap = await request(login.body.token, "/bootstrap", undefined, "GET");
  assert.ok(bootstrap.body.pets.some(item => item.id === pet.id && item.ownerId === customer.id));
  assert.ok((await request(login.body.token, `/appointments?id=${appointment.id}`, undefined, "GET")).body.items.some(item => item.id === appointment.id));
  assert.ok((await request(login.body.token, `/medical-records?id=${medical.id}`, undefined, "GET")).body.items.some(item => item.id === medical.id));
  assert.ok((await request(login.body.token, `/hotel-bookings?id=${booking.id}`, undefined, "GET")).body.items.some(item => item.id === booking.id));
  const invoices = await request(login.body.token, "/invoices", undefined, "GET");
  assert.ok(invoices.body.items.some(item => item.id === invoiced.body.invoice.id && item.ownerId === customer.id));
  assert.equal((await request(ownerToken, `/hotel-bookings/${booking.id}`, undefined, "GET")).status, 404);
  const adminBootstrap = await request(staffToken, `/owners?id=${customer.id}`, undefined, "GET");
  assert.equal(adminBootstrap.body.items.find(item => item.id === customer.id).loginEnabled, true);

  const expiredOwner = await guest(), expired = await issue(expiredOwner);
  await db.ownerActivation.update({ where: { tokenHash: digest(expired.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  for (const token of [expired.token, "bad", "x".repeat(43)]) {
    assert.equal((await request(null, "/auth/owner/activation/inspect", { token })).status, 422);
    assert.equal((await request(null, "/auth/owner/activation", activationBody(token))).status, 422);
  }
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: expiredOwner.id } })).passwordHash, "");

  // Two issue requests serialize on the owner; only the latest committed link remains valid.
  const reissueOwner = await guest();
  const competingIssues = await Promise.all([issue(reissueOwner), issue(reissueOwner)]);
  const pending = await db.ownerActivation.findMany({ where: { ownerId: reissueOwner.id, revokedAt: null } });
  assert.equal(pending.length, 1);
  const valid = competingIssues.find(item => digest(item.token) === pending[0].tokenHash);
  const invalid = competingIssues.find(item => item !== valid);
  assert.equal((await request(null, "/auth/owner/activation/inspect", { token: valid.token })).status, 200);
  assert.equal((await request(null, "/auth/owner/activation/inspect", { token: invalid.token })).status, 422);

  // An email can become occupied after issue. The failed consume must roll back completely.
  const conflictOwner = await guest(), conflict = await issue(conflictOwner);
  await db.user.update({ where: { id: active.id }, data: { email: conflict.email } });
  assert.equal((await request(null, "/auth/owner/activation", activationBody(conflict.token))).status, 409);
  const conflictStored = await db.user.findUniqueOrThrow({ where: { id: conflictOwner.id } });
  assert.equal(conflictStored.passwordHash, ""); assert.equal(conflictStored.email, null);
  assert.equal((await db.ownerActivation.findUniqueOrThrow({ where: { tokenHash: digest(conflict.token) } })).usedAt, null);

  // Cross-owner competition is protected by the email unique constraint, as well as per-owner locks.
  const emailRaceOwners = await Promise.all([guest(), guest()]), raceEmail = `${randomUUID()}@example.test`;
  const raceInvitations = await Promise.all(emailRaceOwners.map(owner => issue(owner, raceEmail)));
  const race = await Promise.all(raceInvitations.map(item => request(null, "/auth/owner/activation", activationBody(item.token))));
  assert.deepEqual(race.map(item => item.status).sort(), [200, 409]);
  const loser = race.findIndex(item => item.status === 409);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: emailRaceOwners[loser].id } })).passwordHash, "");
  assert.equal((await db.ownerActivation.findUniqueOrThrow({ where: { tokenHash: digest(raceInvitations[loser].token) } })).usedAt, null);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: active.id } })).passwordHash, "unchanged");
  console.log("Owner activation integration PASS: 401/403, identity/email validation, no-store/digest/30-minute expiry, revocation, single-use/concurrent consume, no active-account reset, email conflicts and cross-owner race rollback, same-ID login with existing pets/medical/appointments/hotel/invoices preserved and scoped.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (userIds.length) {
    await db.invoice.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}
