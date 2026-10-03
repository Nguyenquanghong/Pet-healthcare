import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { createApp } from "../dist/src/app.js";
import { hashPassword } from "../dist/src/lib/password.js";
import { signToken } from "../dist/src/lib/token.js";

const openapi = await SwaggerParser.validate(JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")));
function validateSchema(schema, value, location = "response") {
  if (schema.$ref) return validateSchema(openapi.components.schemas[schema.$ref.split("/").at(-1)], value, location);
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${location} must be array`);
    value.forEach((item, index) => validateSchema(schema.items, item, `${location}[${index}]`));
  } else if (schema.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${location} must be object`);
    for (const field of schema.required || []) assert.ok(Object.hasOwn(value, field), `${location}.${field} required`);
    for (const [field, child] of Object.entries(schema.properties || {})) {
      if (value[field] !== undefined && value[field] !== null) validateSchema(child, value[field], `${location}.${field}`);
    }
  } else if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${location} must be integer`);
  } else if (schema.type) {
    assert.equal(typeof value, schema.type, `${location} type`);
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} enum`);
}

function validateResponse(path, method, status, body) {
  const basePath = openapi.servers[0].url;
  assert.ok(path.startsWith(`${basePath}/`), `${path} must use the API base URL`);
  const schema = openapi.paths[path.slice(basePath.length)][method.toLowerCase()].responses[String(status)].content?.["application/json"]?.schema;
  assert.ok(schema, `${method} ${path} needs a JSON response schema`);
  validateSchema(schema, body, `${method} ${path}`);
}

test("representative routes keep JSON, auth and method contracts", async () => {
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  const password = hashPassword("owner-password");
  const owner = { id: "owner-1", username: null, phone: "123", email: "owner@example.test", fullName: "Owner", role: "owner", address: null, avatarUrl: null, createdAt: new Date(), updatedAt: new Date(), ...password };
  const pet = { id: "pet-1", ownerId: owner.id, name: "Mochi", species: "dog", breed: null, gender: "unknown", ageLabel: null, weightKg: null, microchipId: null, healthStatus: "healthy", allergies: [], notes: null, avatarUrl: null, identifyingMarks: null, lastSeenLocation: null, qrToken: "qr-1", qrEnabled: true, showOwnerPhone: true, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: true, rescueNote: null, createdAt: new Date(), updatedAt: new Date() };
  const writes = [];
  const client = {
    user: { findFirst: async () => owner, findUnique: async () => owner, findMany: async () => [{ ...owner, pets: [{ id: pet.id }] }] },
    pet: { findMany: async () => [pet], findFirst: async () => ({ ...pet, owner }), findUnique: async () => pet },
    appointment: { findMany: async () => [] },
    medicalRecord: { findMany: async () => [], delete: async () => ({}) },
    medicalImage: { findMany: async () => [], delete: async () => ({}) },
    hotelBooking: { findMany: async () => [] },
    dailyCareNote: { findMany: async () => [] },
    notification: {
      findMany: async () => [],
      create: async ({ data }) => { writes.push({ kind: "notification", data }); return { id: "n-1", status: "sent", ...data }; },
    },
    invoice: { findMany: async () => [] },
    rescueReport: { create: async ({ data }) => { writes.push({ kind: "report", data }); return { id: "r-1", ...data }; } },
    $transaction: async (work) => work(client),
    $queryRaw: async () => [{ "?column?": 1 }],
  };
  for (const name of ["user", "pet", "appointment", "medicalRecord", "medicalImage", "hotelBooking", "dailyCareNote", "notification", "invoice"]) {
    client[name].count = async () => ["user", "pet"].includes(name) ? 1 : 0;
    client[name].groupBy = async () => [];
  }
  const server = createApp(client).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    async function request(path, method = "GET", token, body) {
      const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }
    const login = await request("/api/auth/owner/login", "POST", undefined, { email: owner.email, password: "owner-password" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, owner.id);
    assert.ok(login.body.token);
    validateResponse("/api/auth/owner/login", "POST", 200, login.body);
    const ownerToken = login.body.token;
    const staffToken = signToken("staff-1", "staff");

    const expected = [
      ["/api/health", 200], ["/api/auth/me", 200], ["/api/bootstrap", 200],
      ["/api/pets", 200], ["/api/appointments", 200], ["/api/medical-records", 200],
      ["/api/hotel-bookings", 200], ["/api/notifications", 200], ["/api/invoices", 200],
      ["/api/public/pets/qr-1", 200],
    ];
    for (const [path, status] of expected) {
      const result = await request(path, "GET", path.startsWith("/api/public") || path === "/api/health" ? undefined : ownerToken);
      assert.equal(result.status, status, path);
      assert.ok(result.body, path);
      validateResponse(path === "/api/public/pets/qr-1" ? "/api/public/pets/{token}" : path, "GET", status, result.body);
    }
    const bootstrap = await request("/api/bootstrap", "GET", ownerToken);
    assert.equal(bootstrap.body.currentOwnerId, owner.id);
    assert.equal(bootstrap.body.pets[0].name, pet.name);

    const denied = await request("/api/notifications/send", "POST", ownerToken, { recipientOwnerId: owner.id, title: "Hi", message: "Message" });
    assert.equal(denied.status, 403);
    const sent = await request("/api/notifications/send", "POST", staffToken, { recipientOwnerId: owner.id, title: "Hi", message: "Message" });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.notification.recipientOwnerId, owner.id);
    validateResponse("/api/notifications/send", "POST", 201, sent.body);

    const rescue = await request("/api/public/pets/qr-1/rescue-reports", "POST", undefined, { finderPhone: "000", location: "Park" });
    assert.equal(rescue.status, 201);
    validateResponse("/api/public/pets/{token}/rescue-reports", "POST", 201, rescue.body);
    assert.deepEqual(writes.slice(-2).map((item) => item.kind), ["report", "notification"]);

    const deleted = await request("/api/medical-records/images/img-1", "DELETE", staffToken);
    assert.equal(deleted.status, 204);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
