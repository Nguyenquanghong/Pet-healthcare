import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
let server, base;
const users = [];
async function start() {
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/hotel-bookings`;
}
async function stop() { if (server) await new Promise(resolve => server.close(resolve)); server = null; }
async function request(token, method = "GET", body, path = "", key) {
  const response = await fetch(base + path, { method, headers: {
    Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(key ? { "Idempotency-Key": key } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
try {
  for (const [i, role] of ["owner", "owner", "staff"].entries()) users.push(await db.user.create({ data: {
    role, fullName: `Hotel retry ${i}`, email: `${randomUUID()}@example.test`,
    passwordHash: "unused", passwordSalt: "unused",
  } }));
  const [owner, outsider] = users;
  const [token, otherToken, staffToken] = users.map(user => signToken(user.id, user.role));
  const [pet, secondPet] = await Promise.all(["Mochi", "Milo"].map(name => db.pet.create({ data: {
    ownerId: owner.id, name, species: "dog", allergies: [],
  } })));
  await start();
  const input = { petId: pet.id, checkIn: "2098-01-01", checkOut: "2098-01-03", roomType: "standard", serviceKeys: [] };
  const key = randomUUID();
  assert.equal((await request(token, "POST", input)).status, 422, "Missing key is invalid");
  const concurrent = await Promise.all([request(token, "POST", input, "", key), request(token, "POST", input, "", key)]);
  assert.deepEqual(concurrent.map(item => item.status), [201, 201]);
  const bookingId = concurrent[0].body.booking.id;
  assert.equal(concurrent[1].body.booking.id, bookingId);
  assert.equal(await db.hotelBooking.count({ where: { petId: pet.id } }), 1);
  assert.equal(await db.notification.count({ where: { relatedBookingId: bookingId, type: "hotel_booking_created" } }), 1);
  assert.equal(await db.invoice.count({ where: { hotelBookingId: bookingId } }), 0);
  await stop(); await start();
  assert.equal((await request(token, "POST", input, "", key)).body.booking.id, bookingId, "Replay survives restart");
  assert.equal((await request(token, "POST", { ...input, roomType: "vip" }, "", key)).status, 409);
  assert.equal((await request(otherToken, "GET", undefined, `/${bookingId}`)).status, 404);
  assert.equal((await request(token, "GET", undefined, `/${bookingId}`)).status, 200);
  const overlapping = await Promise.all([
    request(token, "POST", { ...input, checkIn: "2098-02-01", checkOut: "2098-02-04" }, "", randomUUID()),
    request(token, "POST", { ...input, checkIn: "2098-02-02", checkOut: "2098-02-05" }, "", randomUUID()),
  ]);
  assert.deepEqual(overlapping.map(item => item.status).sort(), [201, 409]);
  const acrossActors = await Promise.all([
    request(token, "POST", { ...input, checkIn: "2098-04-01", checkOut: "2098-04-03" }, "", randomUUID()),
    request(staffToken, "POST", { ...input, checkIn: "2098-04-02", checkOut: "2098-04-04" }, "", randomUUID()),
  ]);
  assert.deepEqual(acrossActors.map(item => item.status).sort(), [201, 409], "Pet lock serializes different actors");
  assert.equal((await request(token, "POST", { ...input, checkIn: "2098-02-05", checkOut: "2098-02-06" }, "", randomUUID())).status, 201);
  const crossPetKey = randomUUID();
  const crossPet = await Promise.all([
    request(token, "POST", { ...input, checkIn: "2098-03-01", checkOut: "2098-03-02" }, "", crossPetKey),
    request(token, "POST", { ...input, petId: secondPet.id, checkIn: "2098-03-01", checkOut: "2098-03-02" }, "", crossPetKey),
  ]);
  assert.deepEqual(crossPet.map(item => item.status).sort(), [201, 409], "One key cannot create bookings for two pets");
  for (const changed of [
    { checkIn: "2098-02-31" }, { checkOut: "2098-01-01" },
    { checkIn: "2000-01-01" }, { serviceKeys: "daily_walk" },
    { roomType: "invalid" }, { ownerNote: 1 },
  ]) assert.equal((await request(token, "POST", { ...input, ...changed }, "", randomUUID())).status, 422);
  console.log("Hotel idempotency integration PASS: concurrency, restart replay, payload conflict, same-pet overlap, adjacent stay, owner scope and validation.");
} finally {
  await stop();
  if (users.length) {
    const userIds = users.map(user => user.id);
    const pets = await db.pet.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const petIds = pets.map(pet => pet.id);
    await db.notification.deleteMany({ where: { relatedPetId: { in: petIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
}
