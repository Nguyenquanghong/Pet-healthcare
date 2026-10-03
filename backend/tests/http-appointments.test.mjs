import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";

test("auth middleware protects appointment GET and POST, while valid owner reaches service", async () => {
  process.env.JWT_SECRET = randomBytes(32).toString("hex");
  const client = {
    appointment: { findMany: async () => [], count: async () => 0, groupBy: async () => [] },
    pet: { findUnique: async () => null },
  };
  client.$transaction = async work => work(client);
  const server = createApp(client).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}/api/appointments`;
    const getDenied = await fetch(base);
    const postDenied = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(getDenied.status, 401);
    assert.equal(postDenied.status, 401);
    assert.equal((await getDenied.json()).error, "Authentication is required.");
    assert.equal((await postDenied.json()).error, "Authentication is required.");

    const token = signToken("owner-1", "owner");
    const getAllowed = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(getAllowed.status, 200);
    const page = await getAllowed.json();
    assert.deepEqual(page.items, []);
    assert.deepEqual(page.pagination, { page: 1, pageSize: 20, total: 0, totalPages: 0 });
    const postAllowed = await fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ petId: "missing" }) });
    assert.equal(postAllowed.status, 404);
    assert.deepEqual(await postAllowed.json(), { error: "Pet not found." });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
