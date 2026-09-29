import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { cpus, totalmem, platform, release } from "node:os";
import { B1, createOutputExclusive, fingerprint, gitAt, processOutcome, testDatabase } from "./common.mjs";
import { counts, prepareFixture } from "./fixture.mjs";
import { actions, runActions, startProxy, summarize } from "./workload.mjs";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const childScript = fileURLToPath(new URL("./core-child.mjs", import.meta.url));
const config = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith("--") ? [[value.slice(2), all[index + 1]]] : []));
const variant = args.variant;
const profile = args.profile;
const appRoot = resolve(args["app-root"] || "");
const outputPath = resolve(args.output || "");
const dbUrl = args["db-url"] || process.env.DATABASE_URL || "";
if (!["M1", "M2"].includes(variant) || !["balanced", "inbox-hot", "business-hot"].includes(profile) || !args["app-root"] || !args.output) {
  throw new Error("Usage: run.mjs --app-root <detached B1> --variant M1|M2 --profile balanced|inbox-hot|business-hot --db-url <synthetic loopback _test> --output <new directory>");
}
const database = testDatabase(dbUrl);
const output = await createOutputExclusive(outputPath);
const manifest = { status: "IN_PROGRESS", variant, profile, database, output, startedAt: new Date().toISOString(), baseline: B1,
  screening: true, hostFairness: "same Windows/Linux host, CPU/RAM budgets not enforced", processOutcomes: [], limitations: ["5A one-run screening; no warmup/repeats/Kaggle", "PG CPU/RAM not sampled", "M2 auth limiter is per process"] };
manifest.environment = { node: process.version, os: `${platform()} ${release()}`, cpuModel: cpus()[0]?.model || "unknown", logicalCpus: cpus().length, totalRamMiB: totalmem() / 1024 ** 2 };
const children = [];
let proxy;
let client;
let failure;
let interrupted = false;
const onSignal = () => { interrupted = true; for (const item of children) item.child.kill(); };
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

function writeJson(name, data) { return writeFile(join(output, name), `${JSON.stringify(data, null, 2)}\n`); }
await writeJson("manifest.json", { ...manifest, phase: "created-output" });

function launchCore(number, url, secret) {
  const child = fork(childScript, [appRoot], { cwd: repo, silent: true, windowsHide: true,
    env: { ...process.env, DATABASE_URL: url, JWT_SECRET: secret } });
  const stdout = createWriteStream(join(output, `core-${number}.stdout.log`));
  const stderr = createWriteStream(join(output, `core-${number}.stderr.log`));
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ exitCode: code, signal })));
  const ready = new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Core ${number} readiness timeout`)), 20_000);
    const onMessage = (message) => {
      if (message.type !== "ready") return;
      clearTimeout(timeout); child.off("message", onMessage); done(message);
    };
    child.on("message", onMessage);
    child.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`Core ${number} exited before ready: ${code}/${signal}`)); });
  });
  const item = { child, exited, ready, stdout, stderr, number };
  children.push(item);
  return item;
}

async function stats(item) {
  const id = `stats-${item.number}-${Date.now()}`;
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Core ${item.number} stats timeout`)), 5000);
    const onMessage = (message) => {
      if (message.id !== id) return;
      clearTimeout(timeout); item.child.off("message", onMessage); done(message);
    };
    item.child.on("message", onMessage);
    item.child.send({ type: "stats", id });
  });
}

try {
  const head = await gitAt(appRoot, ["rev-parse", "HEAD"]);
  const branch = await gitAt(appRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = await gitAt(appRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (head.stdout !== B1 || branch.stdout !== "HEAD" || dirty.stdout) throw new Error("App root must be a clean detached B1 worktree");
  await access(join(appRoot, "backend", "dist", "src", "app.js"));
  manifest.appGit = { head: head.stdout, branch: branch.stdout, trackedDirty: false };
  manifest.fingerprintsBefore = {
    app: await fingerprint(appRoot, ["backend/src", "backend/prisma", "backend/dist", "backend/openapi.json", "backend/package.json", "package-lock.json"]),
    harness: await fingerprint(repo, ["benchmarks/phase2", "contracts/notifications/v1"]),
  };
  process.env.DATABASE_URL = dbUrl;
  const secret = randomBytes(48).toString("hex");
  process.env.JWT_SECRET = secret;
  const requireFromB1 = createRequire(join(appRoot, "backend", "package.json"));
  const { PrismaClient } = requireFromB1("@prisma/client");
  client = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await client.$connect();
  manifest.postgres = { maxConnections: Number((await client.$queryRawUnsafe("SHOW max_connections"))[0].max_connections),
    version: (await client.$queryRawUnsafe("SELECT version() AS version"))[0].version };
  const fixture = await prepareFixture(client, appRoot, config.fixture);
  manifest.fixture = { config: fixture.config, counts: fixture.counts };
  await writeJson("manifest.json", { ...manifest, phase: "fixture-ready" });
  const plan = actions(profile, fixture.owners, config.seed);
  if (plan.length !== config.actions) throw new Error("Generated actions do not match frozen config");
  const publicPlan = plan.map(({ token, ...rest }) => rest);
  manifest.workload = { seed: config.seed, actions: plan.length, logicalPayloadSha256: createHash("sha256").update(JSON.stringify(publicPlan)).digest("hex"), distribution: Object.fromEntries([...new Set(plan.map((action) => action.kind))].map((kind) => [kind, plan.filter((action) => action.kind === kind).length])) };
  await client.$disconnect();
  manifest.fixtureConnectionOutsideTiming = true;
  const ports = [];
  for (let i = 0; i < (variant === "M1" ? 1 : 2); i++) {
    const childUrl = new URL(dbUrl);
    childUrl.searchParams.set("connection_limit", String(config.poolLimitTotal / (variant === "M1" ? 1 : 2)));
    const item = launchCore(i + 1, childUrl.toString(), secret);
    const ready = await item.ready;
    ports.push(ready.port);
  }
  proxy = await startProxy(ports);
  manifest.ports = { proxy: proxy.port, core: ports };
  manifest.poolLimitTotal = config.poolLimitTotal;
  await writeJson("manifest.json", { ...manifest, phase: "load-ready" });
  const driverCpuBefore = process.cpuUsage();
  const driverStarted = performance.now();
  const run = await runActions(proxy.port, plan, config.concurrency);
  const driverCpu = process.cpuUsage(driverCpuBefore);
  manifest.driverResource = { cpuMs: (driverCpu.user + driverCpu.system) / 1000, elapsedMs: performance.now() - driverStarted, rssMiB: process.memoryUsage().rss / 1024 ** 2 };
  await writeFile(join(output, "raw.jsonl"), run.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeJson("manifest.json", { ...manifest, phase: "load-complete-unreconciled" });
  const result = summarize(run.rows, run.elapsedMs);
  await client.$connect();
  const finalCounts = await counts(client);
  const expectedBooks = manifest.workload.distribution.book || 0;
  const bookingRows = run.rows.filter((row) => row.kind === "book");
  const bookingIds = bookingRows.map((row) => row.appointmentId).filter(Boolean);
  const [bookingsStored, bookingNotifications] = await Promise.all([
    client.appointment.findMany({ where: { id: { in: bookingIds } }, select: { id: true, ownerId: true, petId: true, appointmentDate: true, appointmentTime: true } }),
    client.notification.findMany({ where: { relatedAppointmentId: { in: bookingIds } }, select: { id: true, relatedAppointmentId: true, recipientRole: true, recipientOwnerId: true } }),
  ]);
  const correlationValid = bookingIds.length === expectedBooks && new Set(bookingIds).size === expectedBooks && bookingsStored.length === expectedBooks && bookingRows.every((row) => {
    const expected = plan[row.id].body;
    const stored = bookingsStored.find((booking) => booking.id === row.appointmentId);
    return stored?.petId === expected.petId && stored?.appointmentDate.toISOString().slice(0, 10) === expected.date && stored?.appointmentTime === expected.time &&
      bookingNotifications.filter((notification) => notification.relatedAppointmentId === row.appointmentId && notification.recipientRole === "admin" && notification.recipientOwnerId === null).length === 1;
  }) && bookingNotifications.length === expectedBooks;
  const reconciliation = { initial: fixture.counts, final: finalCounts, expectedNewAppointments: expectedBooks,
    actualNewAppointments: finalCounts.appointments - fixture.counts.appointments,
    expectedNewNotifications: expectedBooks, actualNewNotifications: finalCounts.notifications - fixture.counts.notifications,
    ownerNotificationsUnchanged: finalCounts.ownerNotifications === fixture.counts.ownerNotifications,
    adminNotificationsDelta: finalCounts.adminNotifications - fixture.counts.adminNotifications,
    bookingIds, correlatedOneAdminNotificationEach: correlationValid };
  manifest.proxy = proxy.stats;
  manifest.postgres.connectionsAtReconcile = Number((await client.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()"))[0].count);
  manifest.coreResources = await Promise.all(children.map(stats));
  await writeJson("summary.json", { ...result, reconciliation });
  if (result.unexpected || reconciliation.actualNewAppointments !== expectedBooks || reconciliation.actualNewNotifications !== expectedBooks || !reconciliation.ownerNotificationsUnchanged || reconciliation.adminNotificationsDelta !== expectedBooks || !correlationValid) {
    throw new Error("Screening status or database delivery reconciliation failed");
  }
  if (interrupted) throw new Error("Run interrupted by signal");
  manifest.status = "PASS_SCREENING_ONLY";
} catch (error) {
  failure = error;
  manifest.status = "FAILED";
  manifest.error = { name: error.name, message: error.message };
} finally {
  if (proxy) { try { await proxy.close(); } catch (error) { failure ||= error; } }
  for (const item of children) {
    if (item.child.exitCode === null && item.child.signalCode === null) {
      try { item.child.send({ type: "stop" }); } catch { /* already exited */ }
    }
    let timeout;
    let outcome = await Promise.race([item.exited, new Promise((done) => { timeout = setTimeout(() => { item.child.kill(); done(null); }, 5000); })]);
    clearTimeout(timeout);
    if (!outcome) outcome = await item.exited;
    manifest.processOutcomes.push({ core: item.number, ...outcome });
    try { processOutcome(outcome.exitCode, outcome.signal, true); } catch (error) { failure ||= error; manifest.status = "FAILED"; }
    item.stdout.end(); item.stderr.end();
  }
  if (client) { try { await client.$disconnect(); } catch (error) { failure ||= error; manifest.status = "FAILED"; } }
  if (manifest.fingerprintsBefore) {
    manifest.fingerprintsAfter = {
      app: await fingerprint(appRoot, ["backend/src", "backend/prisma", "backend/dist", "backend/openapi.json", "backend/package.json", "package-lock.json"]),
      harness: await fingerprint(repo, ["benchmarks/phase2", "contracts/notifications/v1"]),
    };
    if (JSON.stringify(manifest.fingerprintsBefore) !== JSON.stringify(manifest.fingerprintsAfter)) {
      failure ||= new Error("Source or harness changed during run"); manifest.status = "FAILED";
    }
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.cleanup = { proxyClosed: Boolean(proxy), coreStopped: manifest.processOutcomes.length === children.length, prismaDisconnected: Boolean(client) };
  if (failure) { manifest.status = "FAILED"; manifest.error ||= { name: failure.name, message: failure.message }; }
  await writeJson("manifest.json", manifest);
  process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
}
if (failure) { console.error(`Phase2 screening FAILED; evidence: ${output}; ${failure.message}`); process.exitCode = 1; }
else console.log(`Phase2 ${variant} ${profile} PASS_SCREENING_ONLY; evidence: ${output}`);
