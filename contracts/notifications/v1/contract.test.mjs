import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ContractError, MAX_BODY_BYTES, eventPayloadHash, validateContract } from "./validate.mjs";

const timestamp = "2026-09-28T10:00:00.000Z";
const notification = () => ({ id: "notification-1", recipientOwnerId: "owner-1", recipientRole: "owner", type: "appointment_confirmed", title: "Appointment", message: "Confirmed", status: "sent", actionUrl: "/owner/appointments", relatedPetId: "pet-1", relatedAppointmentId: "appointment-1", relatedBookingId: null, sentByStaffId: null, createdAt: timestamp, sentAt: timestamp });
const event = () => ({ version: "v1", eventId: randomUUID(), correlationId: "business-operation-1", producer: "appointments", occurredAt: timestamp, notification: notification() });
const invalid = (name, value) => assert.throws(() => validateContract(name, value), ContractError);

test("valid v1 event, ack, availability, manual result and error", () => {
  const e = event();
  assert.equal(validateContract("event", e), e);
  validateContract("ingestAck", { version: "v1", eventId: e.eventId, notificationId: e.notification.id, outcome: "created" });
  validateContract("availability", { version: "v1", notificationAvailability: "available", notifications: [e.notification] });
  validateContract("availability", { version: "v1", notificationAvailability: "unavailable", notifications: [] });
  validateContract("manualSendResult", { version: "v1", operationId: "op-1", notification: e.notification });
  validateContract("manualSendRequest", { version: "v1", operationId: "op-1", recipientOwnerId: "owner-1", title: "Hello", message: "World" });
  validateContract("error", { version: "v1", code: "NOTIFICATION_COMMIT_UNKNOWN", message: "Check status", operationId: "op-1" });
  assert.equal(eventPayloadHash(e), eventPayloadHash(structuredClone(e)));
});

test("rejects unknown version, fields, bad recipient and payload size", () => {
  invalid("event", { ...event(), version: "v2" });
  const noCorrelation = event(); delete noCorrelation.correlationId; invalid("event", noCorrelation);
  invalid("event", { ...event(), extra: true });
  const e = event(); e.notification.recipientOwnerId = null; invalid("event", e);
  const large = event(); large.notification.message = "x".repeat(MAX_BODY_BYTES); invalid("event", large);
  invalid("availability", { version: "v1", notificationAvailability: "unavailable", notifications: [notification()] });
  invalid("error", { version: "v1", code: "NOTIFICATION_COMMIT_UNKNOWN", message: "Unknown" });
  invalid("manualSendRequest", { version: "v2", operationId: "op-1", recipientOwnerId: "owner-1", title: "Hello", message: "World" });
  const unsafe = event(); unsafe.notification.actionUrl = "javascript:alert(1)"; invalid("event", unsafe);
});

test("actor is shape-validated but signature must be verified by service", () => {
  const now = Math.floor(Date.now() / 1000);
  const actor = { iss: "pet-healthcare-core", aud: "pet-healthcare-notifications", sub: "owner-1", role: "owner", iat: now - 1, exp: now + 30 };
  validateContract("actorClaims", actor, { nowSeconds: now });
  invalid("actorClaims", { ...actor, aud: "wrong" });
  invalid("actorClaims", { ...actor, exp: now - 1 });
  invalid("actorClaims", { ...actor, role: "superuser" });
});

test("same event id with mutated payload has a distinct dedup hash", () => {
  const original = event();
  const changed = structuredClone(original); changed.notification.message = "Changed";
  assert.notEqual(eventPayloadHash(original), eventPayloadHash(changed));
});
