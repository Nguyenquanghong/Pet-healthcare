import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { hashPassword } from "../dist/src/lib/password.js";
import { createAppointmentDependencies } from "../dist/src/infrastructure/persistence/appointmentRepository.js";
import { createMedicalDependencies } from "../dist/src/infrastructure/persistence/medicalRepository.js";
import { createHotelDependencies } from "../dist/src/infrastructure/persistence/hotelRepository.js";
import { createPublicRescueDependencies } from "../dist/src/infrastructure/persistence/publicRescueRepository.js";

const rawUrl = process.env.PG_TEST_DATABASE_URL;
assert.ok(rawUrl, "Set PG_TEST_DATABASE_URL to a migrated, disposable local database whose name ends in _test.");
const parsedUrl = new URL(rawUrl);
assert.ok(["localhost", "127.0.0.1"].includes(parsedUrl.hostname), "Integration tests require a local PostgreSQL host.");
assert.match(decodeURIComponent(parsedUrl.pathname), /_test$/, "Integration tests require a dedicated *_test database.");
assert.ok(["postgresql:", "postgres:"].includes(parsedUrl.protocol), "Integration tests require a PostgreSQL URL.");

process.env.JWT_SECRET = randomBytes(32).toString("hex");
const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const marker = `phase1-${randomBytes(8).toString("hex")}`;
const password = hashPassword("test-password-123");
let owner;
let server;

async function expectRollback(name, work, count) {
  const before = await count();
  const sentinel = new Error(`${name} forced failure`);
  await assert.rejects(work(sentinel), (error) => error === sentinel, `${name} should propagate callback failure`);
  assert.equal(await count(), before, `${name} must roll back the database write`);
}

try {
  await prisma.$connect();
  owner = await prisma.user.create({ data: {
    email: `${marker}@example.test`, fullName: "Phase 1 test owner", role: "owner",
    passwordHash: password.passwordHash, passwordSalt: password.passwordSalt,
  } });
  const pet = await prisma.pet.create({ data: {
    ownerId: owner.id, name: "Test pet", species: "dog", allergies: [], qrToken: marker,
  } });
  const appointment = createAppointmentDependencies(prisma);
  const medical = createMedicalDependencies(prisma);
  const hotel = createHotelDependencies(prisma);
  const rescue = createPublicRescueDependencies(prisma);

  await expectRollback("appointment UoW", (failure) => appointment.unitOfWork.run(async ({ appointments }) => {
    await appointments.create({ petId: pet.id, ownerId: owner.id, doctorId: null, type: "general_checkup",
      serviceName: "Test", clinicName: "Test", appointmentDate: new Date("2030-01-01T00:00:00.000Z"),
      appointmentTime: "10:00", ownerNote: null, createdBy: "owner" });
    throw failure;
  }), () => prisma.appointment.count({ where: { petId: pet.id } }));

  await expectRollback("medical UoW", (failure) => medical.unitOfWork.run(async ({ records }) => {
    await records.create({ petId: pet.id, ownerId: owner.id, appointmentId: null, doctorName: "Test",
      visitDate: new Date("2030-01-01T00:00:00.000Z"), title: "Test", symptoms: null,
      diagnosis: "Test", treatment: "Test", medications: null, vaccineName: null, followUpDate: null,
      internalNote: null });
    throw failure;
  }), () => prisma.medicalRecord.count({ where: { petId: pet.id } }));

  await expectRollback("hotel UoW", (failure) => hotel.unitOfWork.run(async ({ bookings }) => {
    await bookings.create({ petId: pet.id, ownerId: owner.id, checkIn: new Date("2030-01-01T00:00:00.000Z"),
      checkOut: new Date("2030-01-02T00:00:00.000Z"), nights: 1, roomType: "standard",
      serviceKeys: [], totalAmount: 100, ownerNote: null });
    throw failure;
  }), () => prisma.hotelBooking.count({ where: { petId: pet.id } }));

  await expectRollback("rescue UoW", (failure) => rescue.unitOfWork.run(async (reports) => {
    await reports.createReport({ petId: pet.id, finderPhone: "000", location: "Test", finderName: null, note: null });
    throw failure;
  }), () => prisma.rescueReport.count({ where: { petId: pet.id } }));

  server = createApp(prisma).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = "GET", token, body) {
    const response = await fetch(base + path, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status !== 204) assert.match(response.headers.get("content-type") || "", /application\/json/, `${method} ${path} JSON`);
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/api/pets")).status, 401, "protected GET");
  assert.equal((await request("/api/pets", "POST", undefined, { name: "Denied" })).status, 401, "protected POST");
  assert.equal((await request("/api/pets", "GET", "invalid.token.here")).status, 401, "invalid token");
  const login = await request("/api/auth/owner/login", "POST", undefined, { email: owner.email, password: "test-password-123" });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal((await request("/api/pets", "GET", login.body.token)).status, 200);
  assert.equal((await request("/api/notifications/send", "POST", login.body.token,
    { recipientOwnerId: owner.id, title: "Test", message: "Test" })).status, 403, "owner cannot send staff notification");
  const created = await request("/api/pets", "POST", login.body.token, { name: "Created via HTTP", species: "cat" });
  assert.equal(created.status, 201);
  assert.equal(created.body.pet.name, "Created via HTTP");
  const report = await request(`/api/public/pets/${marker}/rescue-reports`, "POST", undefined, { finderPhone: "000", location: "Test park" });
  assert.equal(report.status, 201);
  assert.equal(await prisma.rescueReport.count({ where: { petId: pet.id } }), 1);
  assert.equal(await prisma.notification.count({ where: { recipientOwnerId: owner.id, type: "pet_rescue_report" } }), 1);
  const inbox = await request("/api/notifications", "GET", login.body.token);
  assert.equal(inbox.status, 200);
  assert.ok(Array.isArray(inbox.body));
  const rescueNotification = inbox.body.find((item) => item.type === "pet_rescue_report");
  assert.ok(rescueNotification, "rescue notification must appear in owner inbox");
  assert.equal((await request(`/api/notifications/${rescueNotification.id}`, "DELETE", login.body.token)).status, 204);
  assert.equal(await prisma.notification.count({ where: { id: rescueNotification.id } }), 0);
  console.log("PostgreSQL integration PASS: migrations, four real rollback adapters, health/login, protected GET/POST, JSON, rescue transaction, inbox GET/DELETE, auth 401/403.");
} finally {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (owner) await prisma.user.delete({ where: { id: owner.id } });
  await prisma.$disconnect();
}
