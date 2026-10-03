import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";
import { hashPassword } from "../dist/src/lib/password.js";

const rawUrl = process.env.PG_TEST_DATABASE_URL;
assert.ok(rawUrl, "Use a migrated disposable PG_TEST_DATABASE_URL.");
const parsed = new URL(rawUrl);
assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
assert.match(parsed.pathname, /_test$/);
const externalApi = process.env.PG_TEST_API_BASE_URL;
if (externalApi) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(externalApi).hostname));
  assert.ok(process.env.PG_TEST_JWT_SECRET, "External local test API requires its disposable PG_TEST_JWT_SECRET.");
}
process.env.JWT_SECRET = externalApi ? process.env.PG_TEST_JWT_SECRET : randomBytes(32).toString("hex");
const prisma = new PrismaClient({ datasources: { db: { url: rawUrl } } });
const marker = `phase1-security-${randomUUID()}`;
let server;
const users = [];
const notificationIds = [];
try {
  for (const role of ["owner", "owner", "staff"]) {
    const account = await prisma.user.create({ data: { role, fullName: marker,
      email: `${randomUUID()}@example.test`, ...hashPassword("valid-password") } });
    users.push(account);
  }
  const [owner, other, staff] = users;
  const ownerToken = signToken(owner.id, "owner"), otherToken = signToken(other.id, "owner"), staffToken = signToken(staff.id, "staff");
  if (!externalApi) {
    server = createApp(prisma).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
  }
  const base = externalApi || `http://127.0.0.1:${server.address().port}/api`;
  const request = async (token, method, path, body, status) => {
    const response = await fetch(base + path, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  await request(null, "POST", "/auth/owner/login", undefined, 422);
  await request(null, "POST", "/auth/owner/register", { email: `${randomUUID()}@example.test`, password: "x", confirmPassword: "x" }, 422);
  const { pet } = await request(ownerToken, "POST", "/pets", { name: marker, species: "cat" }, 201);
  assert.match(pet.qrToken, /^[A-Za-z0-9_-]{24}$/);
  for (const path of [`/public/pets/${pet.id}`, `/public/pets/unknown-token`]) await request(null, "GET", path, undefined, 404);
  await request(null, "GET", `/public/pets/${pet.qrToken}`, undefined, 200);
  await request(null, "POST", `/pets/${pet.id}/qr-token`, undefined, 401);
  await request(otherToken, "POST", `/pets/${pet.id}/qr-token`, {}, 403);
  await request(ownerToken, "PATCH", `/pets/${pet.id}`, { qrToken: "caller-token" }, 422);
  await request(ownerToken, "POST", "/pets", { name: marker, qrToken: "caller-token" }, 422);
  const rotated = await request(ownerToken, "POST", `/pets/${pet.id}/qr-token`, undefined, 200);
  assert.notEqual(rotated.pet.qrToken, pet.qrToken);
  const report = { finderPhone: "0900000000", location: "Local test location" };
  for (const revoked of [pet.id, pet.qrToken]) {
    await request(null, "GET", `/public/pets/${revoked}`, undefined, 404);
    await request(null, "POST", `/public/pets/${revoked}/rescue-reports`, report, 404);
  }
  await request(null, "GET", `/public/pets/${rotated.pet.qrToken}`, undefined, 200);
  await request(null, "POST", `/public/pets/${rotated.pet.qrToken}/rescue-reports`, report, 201);
  for (const body of [{ qrEnabled: "false" }, { publicProfile: { showOwnerPhone: "false" } }, { name: " " },
    { weightKg: -2 }, { weightKg: 1e-12 }, { species: "invalid" }]) await request(ownerToken, "PATCH", `/pets/${pet.id}`, body, 422);
  const masked = await request(ownerToken, "PATCH", `/pets/${pet.id}`, { publicProfile: { showOwnerPhone: false } }, 200);
  assert.equal(masked.pet.publicProfile.showOwnerPhone, false);
  await request(ownerToken, "PATCH", `/pets/${pet.id}`, { qrEnabled: false }, 200);
  await request(null, "GET", `/public/pets/${rotated.pet.qrToken}`, undefined, 404);
  await request(null, "POST", `/public/pets/${rotated.pet.qrToken}/rescue-reports`, report, 404);

  const medical = { petId: pet.id, title: "Visit", doctorName: "Doctor", diagnosis: "Healthy", treatment: "Observe", visitDate: "2028-02-29" };
  for (const change of [{ visitDate: "2026-02-30" }, { followUpDate: "2026-02-29" }, { weightKg: -1 }, { heartRateBpm: 1.5 }])
    await request(staffToken, "POST", "/medical-records", { ...medical, ...change }, 422);
  const { record } = await request(staffToken, "POST", "/medical-records", { ...medical, weightKg: 4.2, temperatureC: 38.5, heartRateBpm: 80 }, 201);
  for (const change of [{ title: " " }, { treatment: "" }, { diagnosis: null }, { visitDate: "2026-02-30" }, { weightKg: -1 }])
    await request(staffToken, "PATCH", `/medical-records/${record.id}`, change, 422);
  await request(staffToken, "PATCH", `/medical-records/${record.id}`, { weightKg: null, temperatureC: null, heartRateBpm: null }, 200);
  const stored = await prisma.medicalRecord.findUniqueOrThrow({ where: { id: record.id } });
  assert.equal(stored.title, "Visit"); assert.equal(stored.weightKg, null); assert.equal(stored.heartRateBpm, null);

  const privateNotification = await prisma.notification.create({ data: { recipientOwnerId: owner.id, recipientRole: "owner", type: "general", title: marker, message: "Private" } });
  const staffNotification = await prisma.notification.create({ data: { recipientRole: "admin", type: "general", title: marker, message: "Staff inbox" } });
  notificationIds.push(privateNotification.id, staffNotification.id);
  await request(staffToken, "PATCH", `/notifications/${privateNotification.id}/read`, {}, 404);
  await request(staffToken, "DELETE", `/notifications/${privateNotification.id}`, undefined, 404);
  await request(otherToken, "DELETE", `/notifications/${privateNotification.id}`, undefined, 404);
  assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: privateNotification.id } })).status, privateNotification.status);
  await request(ownerToken, "PATCH", `/notifications/${privateNotification.id}/read`, {}, 200);
  await request(staffToken, "PATCH", `/notifications/${staffNotification.id}/read`, {}, 200);
  await request(staffToken, "DELETE", `/notifications/${staffNotification.id}`, undefined, 204);
  await request(ownerToken, "DELETE", `/notifications/${privateNotification.id}`, undefined, 204);
  console.log("Phase 1 security PostgreSQL PASS: authenticated QR rotation, token/ID revocation for GET and report, paused tokens, strict privacy flags, password/body validation, medical dates/vitals/null persistence, inbox read/delete scope.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.notification.deleteMany({ where: { OR: [{ id: { in: notificationIds } }, { title: marker }] } });
  await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
  await prisma.$disconnect();
}
