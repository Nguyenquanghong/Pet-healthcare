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
      contract.paths["/api/health"].get.responses["503"].content["application/json"].schema.$ref,
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await client.$disconnect();
  }
});
