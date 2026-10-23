import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_HOLD_MS, expiryBounds, pendingExpiresAt } from "../dist/src/domain/hotelPendingExpiry.js";
import { HotelPendingExpiryService } from "../dist/src/application/services/hotelPendingExpiry.js";

// AQ-10: an unconfirmed pending stay expires 48 h after the request or at 12:00 Vietnam
// time (05:00Z) on its check-in day, whichever comes first.
const at = iso => new Date(iso), day = iso => new Date(iso + "T00:00:00.000Z");

test("expiry is the earlier of request + 48 h and 12:00 Vietnam on the check-in day", () => {
  assert.equal(pendingExpiresAt(at("2026-10-23T03:00:00Z"), day("2026-11-10")).toISOString(), "2026-10-25T03:00:00.000Z");
  assert.equal(pendingExpiresAt(at("2026-10-23T03:00:00Z"), day("2026-10-24")).toISOString(), "2026-10-24T05:00:00.000Z");
  assert.equal(pendingExpiresAt(at("2026-10-23T06:00:00Z"), day("2026-10-23")).toISOString(), "2026-10-23T05:00:00.000Z", "a same-day request after noon is already due");
  assert.equal(PENDING_HOLD_MS, 172800000);
});

test("the query bounds select exactly the stays the rule calls expired", () => {
  const now = at("2026-10-23T08:30:00Z"), { createdBefore, checkInOnOrBefore } = expiryBounds(now);
  for (let h = -100; h <= 100; h += 7) for (let d = -3; d <= 4; d++) {
    const createdAt = new Date(now.getTime() + h * 3600000), checkIn = day(new Date(now.getTime() + d * 86400000).toISOString().slice(0, 10));
    assert.equal(pendingExpiresAt(createdAt, checkIn) <= now, createdAt <= createdBefore || checkIn <= checkInOnOrBefore, `${createdAt.toISOString()} ${checkIn.toISOString()}`);
  }
});

test("the service expires each due stay through the store and counts what changed", async () => {
  const calls = [];
  const store = { duePending: async (bounds, limit) => { calls.push(["due", bounds.createdBefore.toISOString(), limit]); return ["a", "b", "c"]; },
    expire: async (id, now) => { calls.push(["expire", id, now.toISOString()]); return id !== "b"; } };
  const now = at("2026-10-23T08:30:00Z");
  assert.deepEqual(await new HotelPendingExpiryService(store).expireDue(now, 10), { due: 3, expired: 2 });
  assert.deepEqual(calls, [["due", "2026-10-21T08:30:00.000Z", 10], ["expire", "a", now.toISOString()], ["expire", "b", now.toISOString()], ["expire", "c", now.toISOString()]]);
});
