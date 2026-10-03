import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { QRPay } from "vietnam-qr-pay";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";

const url = new URL(process.env.PG_TEST_DATABASE_URL || "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.ok(url.pathname.endsWith("_test"), "Only a disposable local *_test database");
Object.assign(process.env, { JWT_SECRET: randomBytes(32).toString("hex"), VNPAY_ENABLED: "false", BANK_TRANSFER_DEMO: "false",
  BANK_TRANSFER_BANK_NAME: "Vietcombank TEST", BANK_TRANSFER_BANK_BIN: "970436", BANK_TRANSFER_ACCOUNT_NUMBER: "123456789", BANK_TRANSFER_ACCOUNT_HOLDER: "TEST ONLY" });
const db = new PrismaClient({ datasources: { db: { url: url.href } } });
const users = [], codes = [];
let server, base;
async function start() {
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
async function stop() { if (server) await new Promise(resolve => server.close(resolve)); }
async function req(path, token, method = "GET", data) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: res.status, headers: res.headers, body: await res.json() };
}
function decode(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  const scanned = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(scanned, "Actual PNG must be scannable");
  const qr = new QRPay(scanned.data); assert.equal(qr.isValid, true); return qr;
}
try {
  for (const role of ["owner", "owner", "staff"]) users.push(await db.user.create({ data: {
    role, fullName: "VietQR test", email: `${randomUUID()}@example.test`, passwordHash: "unused", passwordSalt: "unused",
  } }));
  const [owner] = users;
  const [ownerToken, otherToken, staffToken] = users.map(u => signToken(u.id, u.role));
  const pet = await db.pet.create({ data: { ownerId: owner.id, name: "QR test", species: "dog", allergies: [] } });
  const appointments = await Promise.all(Array.from({ length: 10 }, (_, n) => db.appointment.create({ data: {
    ownerId: owner.id, petId: pet.id, type: "spa_bath", serviceName: "QR test", clinicName: "Test",
    appointmentDate: new Date(`2037-01-${String(n + 1).padStart(2, "0")}`), appointmentTime: "10:00", status: "completed",
  } })));
  await start();
  const results = await Promise.all(appointments.map(a => req("/invoices/checkout", ownerToken, "POST", { type: "appointment", relatedId: a.id })));
  assert.ok(results.every(r => r.status === 200));
  const invoices = results.map(r => r.body.invoice); codes.push(...invoices.map(i => i.invoiceCode));
  assert.ok(invoices.every(i => /^NIPO[0-9]{10}$/.test(i.transferContent)));
  assert.equal(new Set(invoices.map(i => i.transferContent)).size, 10, "Concurrent issuance is unique");
  await assert.rejects(db.invoice.update({ where: { id: invoices[1].id }, data: { transferCode: invoices[0].transferContent } }), { code: "P2002" });
  const invoice = invoices[0], path = `/invoices/${invoice.id}`;
  assert.equal((await req(path + "/transfer-qr", ownerToken)).status, 409, "Must choose bank transfer first");
  const chosen = await req(path + "/bank-transfer", ownerToken, "PATCH", { accountNumber: "forged", transferCode: "NIPO0000000000", totalAmount: 1 });
  assert.equal(chosen.body.invoice.transferContent, invoice.transferContent);
  assert.equal(chosen.body.invoice.bankTransferDetails.accountNumber, "123456789");
  assert.equal((await req(path + "/transfer-qr", null)).status, 401);
  assert.equal((await req(path + "/transfer-qr", otherToken)).status, 404);
  const image = await req(path + "/transfer-qr?amount=1&content=FORGED", ownerToken);
  assert.equal(image.status, 200); assert.equal(image.headers.get("cache-control"), "no-store");
  const qr = decode(image.body.dataUrl);
  assert.equal(qr.consumer.bankBin, "970436"); assert.equal(qr.consumer.bankNumber, "123456789");
  assert.equal(qr.amount, "250000"); assert.equal(qr.currency, "704"); assert.equal(qr.additionalData.purpose, invoice.transferContent);
  await stop();
  process.env.BANK_TRANSFER_ACCOUNT_NUMBER = "987654321";
  await start();
  const persisted = await req(path + "/transfer-qr", ownerToken);
  assert.equal(persisted.body.dataUrl, image.body.dataUrl, "QR is stable after restart and configuration change");
  assert.equal((await req(path + "/transfer-report", ownerToken, "POST", {})).status, 200);
  assert.equal((await req(path + "/transfer-qr", ownerToken)).status, 409);
  assert.equal((await req(path + "/pay", staffToken, "PATCH", { paymentMethod: "bank_transfer" })).status, 200);
  assert.equal((await req(path + "/transfer-qr", ownerToken)).status, 409);
  // Existing invoices keep their original transfer purpose; no invented replacement is shown.
  const legacy = invoices[1];
  await db.invoice.update({ where: { id: legacy.id }, data: { transferCode: null, paymentChannel: "bank_transfer",
    bankTransferDetails: { isDemo: false, bankName: "Legacy bank", accountNumber: "123456789", accountHolder: "TEST ONLY" } } });
  const stored = (await req("/invoices", ownerToken)).body.items;
  assert.equal(stored.find(i => i.id === legacy.id).transferContent, legacy.invoiceCode.replaceAll("-", ""));
  assert.equal((await req(`/invoices/${legacy.id}/transfer-qr`, ownerToken)).status, 409);
  console.log("VietQR integration PASS: 10 concurrent unique codes, DB uniqueness, owner authorization, decoded PNG bank/amount/purpose, immutable snapshot, restart persistence, no QR after report/payment, legacy fallback.");
} finally {
  await stop();
  if (codes.length) await db.notification.deleteMany({ where: { OR: codes.map(code => ({ message: { contains: code } })) } });
  await db.invoice.deleteMany({ where: { ownerId: { in: users.map(u => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } });
  await db.$disconnect();
}
