import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createApp } from "../dist/src/app.js";
import { PetsService } from "../dist/src/application/services/pets.js";
import { MedicalRecordsService } from "../dist/src/application/services/medicalRecords.js";
import { AuthService } from "../dist/src/application/services/auth.js";
import { AppointmentService } from "../dist/src/application/services/appointments.js";
import { NotificationsService } from "../dist/src/application/services/notifications.js";
import { createPublicRescueDependencies } from "../dist/src/infrastructure/persistence/publicRescueRepository.js";
import { PrismaNotificationRepository } from "../dist/src/infrastructure/persistence/notificationRepository.js";
import { qrTokenAdapter } from "../dist/src/infrastructure/security/qrToken.js";
import { hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync } from "../dist/src/lib/password.js";
import { drainServer } from "../dist/src/lib/shutdown.js";
import { todayInVietnam } from "../dist/src/domain/validation.js";

const owner = { sub: "owner", role: "owner" }, staff = { sub: "staff", role: "staff" };

test("pet validation rejects invalid booleans, enums, blank names and numbers without writes", async () => {
  let writes = 0;
  const service = new PetsService({ find: async () => ({ id: "pet", ownerId: "owner" }),
    update: async (_id, data) => { writes++; return data; } }, qrTokenAdapter);
  for (const body of [null, [], { name: " " }, { name: {} }, { species: "bird" }, { gender: "invalid" },
    { healthStatus: "invalid" }, { weightKg: -1 }, { weightKg: true }, { weightKg: "Infinity" },
    { weightKg: 1000 }, { weightKg: 0.001 }, { weightKg: 1e-12 }, { qrEnabled: "false" }, { publicProfile: { showOwnerPhone: "false" } },
    { publicProfile: [] }, { allergies: [1] }, { qrToken: "pet_attacker" }])
    await assert.rejects(service.update(owner, "pet", body), { status: 422 });
  assert.equal(writes, 0);
  const updated = await service.update(owner, "pet", { weightKg: "4.2", qrEnabled: false, publicProfile: { showOwnerPhone: false } });
  assert.deepEqual(updated, { weightKg: 4.2, qrEnabled: false, showOwnerPhone: false });
});

test("QR rotation enforces ownership and uses cryptographic server tokens", async () => {
  const pet = { id: "pet", ownerId: "owner", qrToken: "old-token", qrEnabled: false };
  const service = new PetsService({ find: async id => id === pet.id ? pet : null,
    update: async (_id, data) => Object.assign(pet, data) }, qrTokenAdapter);
  await assert.rejects(service.rotateQrToken({ sub: "other", role: "owner" }, "pet"), { status: 403 });
  await assert.rejects(service.rotateQrToken(owner, "missing"), { status: 404 });
  const rotated = await service.rotateQrToken(owner, "pet");
  assert.match(rotated.qrToken, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(rotated.qrToken, "old-token");
  assert.equal(rotated.qrEnabled, false);
  await assert.rejects(service.create(owner, { name: "Pet", qrToken: "caller-token" }), { status: 422 });
});

test("public rescue lookup and reports accept only the enabled current token", async () => {
  const pet = { id: "pet-id", qrToken: "current-token", qrEnabled: true, owner: {} };
  const reads = createPublicRescueDependencies({ pet: { findFirst: async ({ where }) => {
    assert.deepEqual(Object.keys(where).sort(), ["qrEnabled", "qrToken"]);
    return pet.qrEnabled === where.qrEnabled && pet.qrToken === where.qrToken ? pet : null;
  } } }).reads;
  for (const method of ["findEnabledPetWithOwner", "findEnabledPetForReport"]) {
    assert.ok(await reads[method]("current-token"));
    assert.equal(await reads[method]("pet-id"), null);
    pet.qrToken = "new-token";
    assert.equal(await reads[method]("current-token"), null);
    assert.ok(await reads[method]("new-token"));
    pet.qrEnabled = false;
    assert.equal(await reads[method]("new-token"), null);
    pet.qrEnabled = true; pet.qrToken = "current-token";
  }
});

test("medical create and patch validate actual dates, required text and optional vitals", async () => {
  const pet = { id: "pet", ownerId: "owner", name: "Pet" };
  let writes = 0;
  const records = { findPet: async () => pet, find: async () => ({ ...pet, id: "record", petId: "pet", appointmentId: null }),
    create: async data => { writes++; return { ...data, id: "record" }; },
    update: async (_id, data) => { writes++; return data; } };
  const service = new MedicalRecordsService({ records,
    unitOfWork: { run: work => work({ records, notifications: { create: async () => {} } }) } });
  const valid = { petId: "pet", title: "Visit", doctorName: "Doctor", diagnosis: "Healthy", treatment: "Observe", visitDate: "2028-02-29" };
  for (const change of [{ visitDate: "2026-02-30" }, { followUpDate: "2026-02-29" }, { title: " " },
    { weightKg: -2 }, { weightKg: false }, { weightKg: 0.001 }, { temperatureC: 38.55 }, { temperatureC: "NaN" }, { heartRateBpm: 1.5 }, { appointmentId: {} }])
    await assert.rejects(service.create(staff, { ...valid, ...change }), { status: 422 });
  for (const change of [{ visitDate: "" }, { visitDate: "0000-01-01" }, { followUpDate: false },
    { title: " " }, { diagnosis: null }, { treatment: "" }, { weightKg: -1 }, { heartRateBpm: 0 }])
    await assert.rejects(service.update(staff, "record", change), { status: 422 });
  assert.equal(writes, 0);
  const created = await service.create(staff, { ...valid, weightKg: "4.2", temperatureC: 38.5, heartRateBpm: 80 });
  assert.equal(created.visitDate.toISOString(), "2028-02-29T00:00:00.000Z");
  const cleared = await service.update(staff, "record", { weightKg: null, temperatureC: "", followUpDate: null });
  assert.deepEqual(cleared, { weightKg: null, temperatureC: null, followUpDate: null });
});

test("registration and password change enforce 8-128 and await asynchronous password verification", async () => {
  let writes = 0;
  const user = { id: "owner", role: "owner", passwordHash: "hash", passwordSalt: "salt" };
  const service = new AuthService({ users: { findByEmail: async () => null, findOwnerByEmail: async () => user,
    findStaffByUsername: async () => user, findById: async () => user, createOwner: async data => { writes++; return { ...user, ...data }; },
    updatePassword: async () => { writes++; } }, passwords: { hash: async () => ({ passwordHash: "new", passwordSalt: "new" }),
    verify: async () => false }, tokens: { sign: () => "token" } });
  for (const password of ["x", "x".repeat(129)]) {
    await assert.rejects(service.registerOwner({ email: "owner@example.test", password, confirmPassword: password }), { status: 422 });
    await assert.rejects(service.changePassword(owner, { currentPassword: "old", newPassword: password, confirmPassword: password }), { status: 422 });
  }
  await assert.rejects(service.ownerLogin({ email: "owner@example.test", password: "password" }), { status: 401 });
  await assert.rejects(service.adminLogin({ username: "staff", password: "password" }), { status: 401 });
  assert.equal(writes, 0);
  const result = await service.registerOwner({ email: "owner@example.test", password: "valid-pass", confirmPassword: "valid-pass" });
  assert.equal(result.user.passwordHash, "new");
});

test("real Express returns validation errors for missing and non-object auth bodies", async () => {
  const server = createApp({}).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/auth/owner/login", "/auth/admin/login", "/auth/owner/register", "/auth/owner/activation"]) {
      const response = await fetch(`${base}/api${path}`, { method: "POST" });
      assert.equal(response.status, 422);
      assert.equal(typeof (await response.json()).error, "string");
    }
    const array = await fetch(`${base}/api/auth/owner/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "[]" });
    assert.equal(array.status, 422);
    const rotate = await fetch(`${base}/api/pets/pet/qr-token`, { method: "POST" });
    assert.equal(rotate.status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Vietnam midnight disallows yesterday for appointment create and reschedule", async () => {
  const now = Date.now;
  Date.now = () => Date.parse("2026-10-01T17:30:00Z");
  try {
    assert.equal(todayInVietnam(), "2026-10-02");
    const pet = { id: "pet", ownerId: "owner" };
    const service = new AppointmentService({ appointments: { findPet: async () => pet, hasSlot: async () => true,
      find: async () => ({ id: "appointment", petId: "pet", ownerId: "owner", status: "pending" }) } }, {});
    await assert.rejects(service.create(owner, { petId: "pet", type: "general_checkup", date: "2026-10-01", time: "10:00", serviceName: "Visit" }), { status: 422 });
    await assert.rejects(service.reschedule(owner, "appointment", { date: "2026-10-01", time: "10:00" }), { status: 422 });
    await assert.rejects(service.create(owner, { petId: "pet", type: "general_checkup", date: "2026-10-02", time: "10:00", serviceName: "Visit" }), { status: 409 });
    await assert.rejects(service.reschedule(owner, "appointment", { date: "2026-10-02", time: "10:00" }), { status: 409 });
  } finally { Date.now = now; }
});

test("staff notification mutations are restricted to the visible inbox, including concurrent deletion", async () => {
  const scopes = [];
  const service = new NotificationsService({ findVisible: async (_id, scope) => { scopes.push(scope); return null; } });
  await assert.rejects(service.markRead(staff, "owner-private"), { status: 404 });
  await assert.rejects(service.delete(staff, "owner-private"), { status: 404 });
  assert.deepEqual(scopes, [{ recipientRole: "admin" }, { recipientRole: "admin" }]);
  const repository = new PrismaNotificationRepository({ notification: { updateMany: async ({ where }) => {
    assert.deepEqual(where, { id: "gone", recipientRole: "admin" }); return { count: 0 };
  }, deleteMany: async ({ where }) => { assert.deepEqual(where, { id: "gone", recipientOwnerId: "owner" }); return { count: 0 }; } } });
  assert.equal(await repository.markRead("gone", { recipientRole: "admin" }), null);
  assert.equal(await repository.delete("gone", { recipientOwnerId: "owner" }), false);
});

test("async PBKDF2 remains compatible with existing stored passwords and yields to the event loop", async () => {
  const old = hashPassword("valid-pass");
  assert.equal(await verifyPasswordAsync("valid-pass", old.passwordHash, old.passwordSalt), true);
  assert.equal(await verifyPasswordAsync("wrong", old.passwordHash, old.passwordSalt), false);
  let completed = false;
  const pending = hashPasswordAsync("new-pass").then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, "hashing must allow another event-loop turn before completion");
  const value = await pending;
  assert.equal(verifyPassword("new-pass", value.passwordHash, value.passwordSalt), true);
});

test("shutdown waits for in-flight HTTP work before closing server", async () => {
  let started, finish;
  const incoming = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const server = createServer(async (_req, res) => { started(); await held; res.end("saved"); }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const response = fetch(`http://127.0.0.1:${server.address().port}`);
  await incoming;
  let closed = false;
  const draining = drainServer(server, 2000).then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  finish();
  assert.equal(await (await response).text(), "saved");
  await draining;
  assert.equal(closed, true);
});
