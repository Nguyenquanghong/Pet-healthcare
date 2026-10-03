import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/src/app.js";

test("OpenAPI JSON and Swagger UI are served without a database", async () => {
  const server = createApp({}).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const jsonResponse = await fetch(`${base}/api/openapi.json`);
    assert.equal(jsonResponse.status, 200);
    assert.match(jsonResponse.headers.get("content-type"), /application\/json/);
    const spec = await jsonResponse.json();
    assert.equal(spec.openapi, "3.0.3");
    assert.equal(spec.servers[0].url, "/api");
    assert.ok(spec.paths["/appointments"]);
    const uiResponse = await fetch(`${base}/api/docs/`);
    assert.equal(uiResponse.status, 200);
    assert.match(await uiResponse.text(), /swagger-ui/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
