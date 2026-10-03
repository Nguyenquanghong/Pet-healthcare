import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";

test("app factory serves OpenAPI/Swagger and protects GET/POST before DB access", async () => {
  const client = new PrismaClient({ datasources: { db: {
    url: "postgresql://test:test@127.0.0.1:0/nipopeto_test",
  } } });
  const server = createApp(client).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const docs = await fetch(`${base}/api/docs/`);
    assert.equal(docs.status, 200);
    const html = await docs.text();
    assert.match(html, /<title>NIPOPETO API docs<\/title>/);
    assert.match(html, /id="swagger-ui"/);
    const script = await fetch(`${base}/api/docs/swagger-ui-init.js`);
    assert.equal(script.status, 200);
    const spec = await fetch(`${base}/api/openapi.json`);
    assert.equal(spec.status, 200);
    const contract = await spec.json();
    assert.equal(contract.openapi, "3.0.3");
    assert.equal(
      contract.paths["/health"].get.responses["503"].content["application/json"].schema.$ref,
      "#/components/schemas/Health",
    );
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, "degraded");
    const get = await fetch(`${base}/api/pets`);
    const post = await fetch(`${base}/api/pets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(get.status, 401);
    assert.equal(post.status, 401);
    assert.equal((await get.json()).error, "Authentication is required.");
    assert.equal((await post.json()).error, "Authentication is required.");
    const malformed = await fetch(`${base}/api/auth/owner/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{broken",
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /valid JSON/);
    const oversized = await fetch(`${base}/api/auth/owner/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(10 * 1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /too large/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await client.$disconnect();
  }
});

test("auth rate limit remains 50 per 15 minutes and returns JSON with retry header", async () => {
  const client = new PrismaClient({ datasources: { db: {
    url: "postgresql://test:test@127.0.0.1:0/nipopeto_test",
  } } });
  const server = createApp(client).listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/auth/me`;
    for (let index = 0; index < 50; index++) {
      const response = await fetch(url);
      assert.equal(response.status, 401, `request ${index + 1} should reach auth middleware`);
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      await response.json();
    }
    const blocked = await fetch(url);
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get("content-type") || "", /application\/json/);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal(typeof (await blocked.json()).error, "string");
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await client.$disconnect();
  }
});
