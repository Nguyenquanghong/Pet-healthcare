import assert from "node:assert/strict";
import test from "node:test";
import { hotelStayWrite } from "../dist/src/infrastructure/persistence/hotelStayConflict.js";

// AQ-10: exclusion-constraint violations from any hotel writer become the same 409 as the service check.
test("exclusion violation by constraint name or SQLSTATE 23P01 maps to 409", async () => {
  const byName = Object.assign(new Error('conflicting key value violates exclusion constraint "hotel_bookings_pet_active_stay_excl"'), { code: "P2010" });
  const bySqlState = Object.assign(new Error("Raw query failed"), { meta: { code: "23P01", message: "conflicting key value" } });
  for (const error of [byName, bySqlState])
    await assert.rejects(hotelStayWrite(Promise.reject(error)), e => e.status === 409 && /trùng khoảng ngày/.test(e.message));
});

test("other errors and successful writes pass through unchanged", async () => {
  const unique = Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["actor_id", "request_key"] } });
  await assert.rejects(hotelStayWrite(Promise.reject(unique)), e => e === unique);
  assert.deepEqual(await hotelStayWrite(Promise.resolve({ id: "b" })), { id: "b" });
});
