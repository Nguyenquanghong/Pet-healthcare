import assert from "node:assert/strict";
import test from "node:test";
import { ListsService, parseListQuery } from "../dist/src/application/services/lists.js";

test("pagination rejects malformed, repeated and excessive parameters before accessing data", () => {
  assert.deepEqual(parseListQuery("pets", {}), { page: 1, pageSize: 20 });
  assert.equal(parseListQuery("pets", { page: "2", pageSize: "100", q: " Mochi " }).q, "Mochi");
  assert.equal(parseListQuery("pets", { q: "all", species: "all" }).q, "all");
  assert.equal(parseListQuery("pets", { species: "all" }).species, undefined);
  for (const params of [{ page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "01" }, { page: ["1", "2"] }, { pageSize: "101" }, { pageSize: "0" }, { page: "1000001" }, { species: "invalid" }, { healthStatus: "false" }, { q: "x".repeat(101) }])
    assert.throws(() => parseListQuery("pets", params), { status: 422 });
  assert.throws(() => parseListQuery("appointments", { date: "2026-02-30" }), { status: 422 });
  assert.throws(() => parseListQuery("appointments", { statusGroup: "invalid" }), { status: 422 });
});

test("owner pagination scope always uses the JWT subject, and directories/analytics require staff", async () => {
  const calls = [];
  const service = new ListsService({ page: async (...args) => { calls.push(args); return { data: {}, total: 21, counts: {} }; } });
  const page = await service.load("pets", { sub: "mine", role: "owner" }, { ownerId: "other", page: "2" });
  assert.deepEqual(calls[0][1], { ownerId: "mine" });
  assert.deepEqual(page.pagination, { page: 2, pageSize: 20, total: 21, totalPages: 2 });
  await service.load("notifications", { sub: "staff", role: "doctor" }, {});
  assert.deepEqual(calls[1][1], { recipientRole: "admin" });
  await assert.rejects(service.load("owners", { sub: "mine", role: "owner" }, {}), { status: 403 });
  await assert.rejects(service.billingFigures({ sub: "mine", role: "owner" }), { status: 403 });
  await assert.rejects(service.calendar({ sub: "mine", role: "owner" }, "2026-13"), { status: 422 });
});
