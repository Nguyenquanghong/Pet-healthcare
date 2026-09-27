import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { hashPassword } from "../dist/src/lib/password.js";
import { createMedicalDependencies } from "../dist/src/infrastructure/persistence/medicalRepository.js";

const rawUrl = process.env.PG_TEST_DATABASE_URL;
assert.ok(rawUrl, "Set PG_TEST_DATABASE_URL to a migrated, disposable local *_test database.");
const parsed = new URL(rawUrl);
assert.ok(["postgresql:", "postgres:"].includes(parsed.protocol));
assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
assert.match(decodeURIComponent(parsed.pathname), /_test$/);
process.env.JWT_SECRET = randomBytes(32).toString("hex");

const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const marker = `fix-${randomBytes(8).toString("hex")}`;
const password = hashPassword("synthetic-password-123");
const summary = { race: [], scenarios: [] };
let server;
let owner;
let otherOwner;
let staff;

try {
  await prisma.$connect();
  owner = await prisma.user.create({ data: { email: `${marker}@example.test`, fullName: "Fix owner", role: "owner", ...password, phone: "000111", address: "Private address" } });
  otherOwner = await prisma.user.create({ data: { email: `${marker}-other@example.test`, fullName: "Other owner", role: "owner", ...password } });
  staff = await prisma.user.create({ data: { username: marker, fullName: "Fix staff", role: "staff", ...password } });
  const pet = await prisma.pet.create({ data: {
    ownerId: owner.id, name: "Fix pet", species: "dog", allergies: ["SECRET_ALLERGY"],
    healthStatus: "critical", notes: "SECRET_NOTE", qrToken: marker, rescueNote: "Public rescue note",
    showOwnerPhone: false, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: false,
  } });
  const sibling = await prisma.pet.create({ data: { ownerId: owner.id, name: "Sibling", species: "cat", allergies: [] } });
  const foreign = await prisma.pet.create({ data: { ownerId: otherOwner.id, name: "Foreign", species: "cat", allergies: [] } });
  server = createApp(prisma).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = "GET", token, body) {
    const response = await fetch(base + path, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    assert.match(response.headers.get("content-type") || "", /application\/json/, `${method} ${path} should return JSON`);
    return { status: response.status, body: await response.json() };
  }
  const login = await request("/api/auth/owner/login", "POST", undefined, { email: owner.email, password: "synthetic-password-123" });
  const staffLogin = await request("/api/auth/admin/login", "POST", undefined, { username: marker, password: "synthetic-password-123" });
  assert.equal(login.status, 200);
  assert.equal(staffLogin.status, 200);
  const token = login.body.token;
  const staffToken = staffLogin.body.token;
  const book = (petId, date, time = "10:00") => ({ petId, type: "general_checkup", serviceName: "Fix checkup", date, time });
  async function create(petId, date, time) {
    const response = await request("/api/appointments", "POST", token, book(petId, date, time));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.appointment;
  }

  // Warm the HTTP and Prisma paths, then dispatch each same-slot wave without awaiting within it.
  await Promise.all(Array.from({ length: 50 }, () => request("/api/health")));
  for (const day of [10, 11, 12]) {
    const date = `2099-01-${day}`;
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => request("/api/appointments", "POST", token, book(pet.id, date))));
    const counts = { 201: results.filter(result => result.status === 201).length, 409: results.filter(result => result.status === 409).length };
    assert.deepEqual(counts, { 201: 1, 409: 49 }, `race ${date}: ${JSON.stringify(results.map(result => result.status))}`);
    assert.ok(results.filter(result => result.status === 409).every(result => typeof result.body.error === "string"));
    const stored = await prisma.appointment.findMany({ where: { petId: pet.id, appointmentDate: new Date(`${date}T00:00:00.000Z`), appointmentTime: "10:00" } });
    assert.equal(stored.length, 1);
    assert.equal(await prisma.notification.count({ where: { type: "appointment_created", relatedAppointmentId: stored[0].id } }), 1);
    summary.race.push({ date, dispatched: 50, ...counts, stored: stored.length, notifications: 1, elapsedMs: Math.round(performance.now() - started) });
  }

  const first = await create(pet.id, "2099-01-13");
  const occupied = await create(pet.id, "2099-01-14");
  const notificationsBeforeReschedule = await prisma.notification.count({ where: { relatedAppointmentId: first.id } });
  const collision = await request(`/api/appointments/${first.id}/reschedule`, "PATCH", token, { date: "2099-01-14", time: "10:00" });
  assert.equal(collision.status, 409, JSON.stringify(collision.body));
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: first.id } })).appointmentDate.toISOString().slice(0, 10), "2099-01-13");
  assert.equal(await prisma.notification.count({ where: { relatedAppointmentId: first.id } }), notificationsBeforeReschedule);
  assert.equal((await request(`/api/appointments/${first.id}/reschedule`, "PATCH", token, { date: "2099-01-13", time: "10:00" })).status, 200, "self-reschedule");
  summary.scenarios.push("reschedule collision 409 atomic; self-reschedule 200");

  const contenderA = await create(pet.id, "2099-01-22", "09:00");
  const contenderB = await create(pet.id, "2099-01-23", "09:00");
  const beforeMove = Object.fromEntries(await Promise.all([contenderA, contenderB].map(async item => [item.id, await prisma.notification.count({ where: { relatedAppointmentId: item.id } })])));
  const moves = await Promise.all([contenderA, contenderB].map(item => request(`/api/appointments/${item.id}/reschedule`, "PATCH", token, { date: "2099-01-24", time: "11:00" })));
  assert.deepEqual(moves.map(result => result.status).sort(), [200, 409]);
  assert.equal(await prisma.appointment.count({ where: { petId: pet.id, appointmentDate: new Date("2099-01-24T00:00:00.000Z"), appointmentTime: "11:00" } }), 1);
  const loser = moves[0].status === 409 ? contenderA : contenderB;
  const winner = moves[0].status === 200 ? contenderA : contenderB;
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: loser.id } })).appointmentDate.toISOString().slice(0, 10), loser.date);
  assert.equal(await prisma.notification.count({ where: { relatedAppointmentId: loser.id } }), beforeMove[loser.id]);
  assert.equal(await prisma.notification.count({ where: { relatedAppointmentId: winner.id } }), beforeMove[winner.id] + 1);
  summary.scenarios.push("concurrent reschedule into empty slot: one 200, one 409, loser unchanged and no notification");

  assert.equal((await request(`/api/appointments/${occupied.id}/cancel`, "PATCH", token, {})).status, 200);
  const replacement = await create(pet.id, "2099-01-14");
  const beforeStatus = await prisma.notification.count({ where: { relatedAppointmentId: occupied.id } });
  assert.equal((await request(`/api/appointments/${occupied.id}/status`, "PATCH", staffToken, { status: "confirmed" })).status, 409);
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: occupied.id } })).status, "cancelled");
  assert.equal(await prisma.notification.count({ where: { relatedAppointmentId: occupied.id } }), beforeStatus);
  assert.equal((await request(`/api/appointments/${replacement.id}/status`, "PATCH", staffToken, { status: "no_show" })).status, 200);
  await create(pet.id, "2099-01-14");
  await create(sibling.id, "2099-01-14");
  await create(pet.id, "2099-01-14", "11:00");
  summary.scenarios.push("cancelled/no_show slot reuse; reactivation collision 409 atomic; another pet and another time allowed");

  const medicalInput = (petId, appointmentId) => ({ petId, appointmentId, doctorName: "Fix doctor", visitDate: "2099-01-14", title: "Fix record", diagnosis: "Checked", treatment: "Observe" });
  const baseline = async () => ({ records: await prisma.medicalRecord.count(), notifications: await prisma.notification.count({ where: { type: "medical_record_updated" } }) });
  const siblingAppointment = await create(sibling.id, "2099-01-19");
  const foreignAppointment = await prisma.appointment.create({ data: { petId: foreign.id, ownerId: otherOwner.id, type: "general_checkup", serviceName: "Foreign", clinicName: "Test", appointmentDate: new Date("2099-01-20T00:00:00.000Z"), appointmentTime: "10:00", createdBy: "owner" } });
  for (const [name, id, expected] of [["missing", "nonexistent-id", 404], ["same owner other pet", siblingAppointment.id, 422], ["other owner", foreignAppointment.id, 422]]) {
    const before = await baseline();
    const response = await request("/api/medical-records", "POST", staffToken, medicalInput(pet.id, id));
    assert.equal(response.status, expected, `${name}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(await baseline(), before, `${name} must have no record/notification side effect`);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id } }).catch(() => null))?.status ?? null, id === "nonexistent-id" ? null : "pending");
    summary.scenarios.push(`medical ${name} ${expected} no side effects`);
  }
  const standalone = await request("/api/medical-records", "POST", staffToken, medicalInput(pet.id, undefined));
  assert.equal(standalone.status, 201);
  const valid = await request("/api/medical-records", "POST", staffToken, medicalInput(pet.id, first.id));
  assert.equal(valid.status, 201, JSON.stringify(valid.body));
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: first.id } })).status, "completed");
  summary.scenarios.push("medical standalone and matching link 201");

  // A no-show appointment would become active on completion; its write must fail atomically.
  const beforeConflict = await baseline();
  const completion = await request("/api/medical-records", "POST", staffToken, medicalInput(pet.id, replacement.id));
  assert.equal(completion.status, 409, JSON.stringify(completion.body));
  assert.deepEqual(await baseline(), beforeConflict);
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: replacement.id } })).status, "no_show");
  summary.scenarios.push("medical completion slot collision 409 atomic");

  const medical = createMedicalDependencies(prisma);
  const rollbackAppointment = await create(pet.id, "2099-01-21");
  const beforeRollback = await baseline();
  const sentinel = new Error("synthetic notification failure");
  await assert.rejects(medical.unitOfWork.run(async ({ records }) => {
    await records.create({ petId: pet.id, ownerId: owner.id, appointmentId: rollbackAppointment.id, doctorName: "Fix", visitDate: new Date("2099-01-21T00:00:00.000Z"), title: "Rollback", symptoms: null, diagnosis: "Fix", treatment: "Fix", medications: null, vaccineName: null, followUpDate: null, internalNote: null });
    await records.completeAppointment(rollbackAppointment.id);
    throw sentinel;
  }), error => error === sentinel);
  assert.deepEqual(await baseline(), beforeRollback);
  assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: rollbackAppointment.id } })).status, "pending");
  summary.scenarios.push("medical record + completion rollback on notification failure");

  const publicPath = `/api/public/pets/${marker}`;
  const hidden = await request(publicPath);
  assert.equal(hidden.status, 200);
  assert.ok(!JSON.stringify(hidden.body).includes("SECRET_ALLERGY"));
  assert.ok(!JSON.stringify(hidden.body).includes("SECRET_NOTE"));
  assert.ok(!JSON.stringify(hidden.body).includes("critical"));
  assert.equal(hidden.body.pet.publicProfile.rescueNote, "Public rescue note");
  assert.equal(hidden.body.owner.phone, "");
  assert.equal(hidden.body.owner.email, undefined);
  assert.equal(hidden.body.owner.address, undefined);
  await prisma.pet.update({ where: { id: pet.id }, data: { showMedicalAlerts: true, showOwnerPhone: true, showOwnerEmail: true, showOwnerAddress: true } });
  const shown = await request(publicPath);
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body.pet.allergies, ["SECRET_ALLERGY"]);
  assert.equal(shown.body.pet.healthStatus, "critical");
  assert.ok(!JSON.stringify(shown.body).includes("SECRET_NOTE"));
  assert.equal(shown.body.owner.phone, "000111");
  assert.equal(shown.body.owner.email, owner.email);
  assert.equal(shown.body.owner.address, "Private address");
  const privatePets = await request("/api/pets", "GET", token);
  assert.equal(privatePets.status, 200);
  assert.equal(privatePets.body.find(item => item.id === pet.id).notes, "SECRET_NOTE");
  summary.scenarios.push("public alerts false/true and contact flags; private notes preserved");

  if (process.env.FIX_TEST_OUTPUT) await writeFile(process.env.FIX_TEST_OUTPUT, JSON.stringify(summary, null, 2));
  console.log(`Fix PostgreSQL integration PASS: ${JSON.stringify(summary)}`);
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const user of [owner, otherOwner]) {
    if (!user) continue;
    const pets = await prisma.pet.findMany({ where: { ownerId: user.id }, select: { id: true } });
    await prisma.notification.deleteMany({ where: { relatedPetId: { in: pets.map(pet => pet.id) } } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  if (staff) await prisma.user.delete({ where: { id: staff.id } });
  await prisma.$disconnect();
}
