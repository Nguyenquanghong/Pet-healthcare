import http from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { testDatabase } from "./common.mjs";

const appRoot = resolve(process.argv[2] || "");
testDatabase(process.env.DATABASE_URL || "");
const requireFromB1 = createRequire(join(appRoot, "backend", "package.json"));
const { PrismaClient } = requireFromB1("@prisma/client");
const { createApp } = await import(pathToFileURL(join(appRoot, "backend", "dist", "src", "app.js")));
const client = new PrismaClient();
await client.$connect();
const app = createApp(client);
const started = performance.now();
const cpuStart = process.cpuUsage();
let peakRss = process.memoryUsage().rss;
let requests = 0;
let maxActive = 0;
let active = 0;
const statuses = {};
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
const server = http.createServer((req, res) => {
  active++; requests++; maxActive = Math.max(maxActive, active);
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true; active--;
    statuses[res.statusCode] = (statuses[res.statusCode] || 0) + 1;
  };
  res.once("finish", finish); res.once("close", finish);
  app(req, res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.send?.({ type: "ready", port: server.address().port, pid: process.pid });

process.on("message", async (message) => {
  if (message.type === "stats") {
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    process.send?.({ id: message.id, requests, active, maxActive, statuses, elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000, peakRssMiB: peakRss / 1024 ** 2 });
  }
  if (message.type === "stop") {
    clearInterval(sample);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await client.$disconnect();
    process.exit(0);
  }
});
