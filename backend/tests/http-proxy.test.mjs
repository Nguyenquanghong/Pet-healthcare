import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";

async function withApp(proxyHops, run) {
  const client = new PrismaClient({ datasources: { db: {
    url: "postgresql://test:test@127.0.0.1:0/nipopeto_test",
  } } });
  const previous = process.env.TRUST_PROXY_HOPS;
  let app;
  try {
    if (proxyHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = proxyHops;
    app = createApp(client);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = previous;
  }
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/auth/me`;
    await run(async forwardedFor => {
      const response = await fetch(url, {
        headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      });
      await response.json();
      return response.status;
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await client.$disconnect();
  }
}

test("one-hop proxy applies auth limits per client and ignores a forged earlier hop", async () => {
  await withApp("1", async request => {
    for (let index = 0; index < 50; index++) {
      assert.equal(await request("203.0.113.99, 198.51.100.10"), 401);
    }
    assert.equal(await request("203.0.113.77, 198.51.100.10"), 429);
    assert.equal(await request("198.51.100.11"), 401);
  });
});

test("direct execution cannot bypass an auth limit with a forwarded IP", async () => {
  await withApp(undefined, async request => {
    for (let index = 0; index < 50; index++) {
      assert.equal(await request(), 401);
    }
    assert.equal(await request("198.51.100.20"), 429);
  });
});
