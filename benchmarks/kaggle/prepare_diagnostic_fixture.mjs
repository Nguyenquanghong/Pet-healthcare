import { writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../backend/dist/src/lib/password.js";
import { signToken } from "../../backend/dist/src/lib/token.js";
import { prepareSyntheticFixture } from "./fixtureData.mjs";
import { prepareDiagnosticHistory } from "./diagnosticFixture.mjs";

const count = Number(process.env.BENCH_USERS), rows = Number(process.env.BENCH_HISTORY_ROWS);
if (process.env.BENCH_DIAGNOSTIC !== "1" || !process.env.BENCH_FIXTURE || !process.env.BENCH_PASSWORD ||
    !Number.isInteger(count) || count < 1 || count > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 100000) {
  throw new Error("Explicit diagnostic environment, fixture path, password, 1..1000 users and 1..100000 history rows required.");
}
const prisma = new PrismaClient();
try {
  const users = await prepareSyntheticFixture(prisma, { count, seed: "diagnostic", password: process.env.BENCH_PASSWORD, hashPassword, signToken });
  const admin = await prisma.user.create({ data: { email: "diagnostic-admin@example.test", fullName: "Synthetic admin", role: "admin",
    ...hashPassword(process.env.BENCH_PASSWORD) } });
  const counts = await prepareDiagnosticHistory(prisma, users, rows, admin.id);
  // Fresh bulk data needs planner statistics before its first measured queries.
  await prisma.$executeRawUnsafe("ANALYZE");
  await writeFile(process.env.BENCH_FIXTURE, JSON.stringify({ users, admin: { token: signToken(admin.id, "admin") }, counts }), { mode: 0o600 });
  if (process.env.BENCH_FIXTURE_SUMMARY) await writeFile(process.env.BENCH_FIXTURE_SUMMARY,
    JSON.stringify({ owners: count, pets: count, admins: 1, ...counts, analyzed: true }, null, 2));
  process.stdout.write(`Prepared diagnostic fixture: ${count} owners, ${rows} historical episodes (8 rows/episode), ANALYZE complete.\n`);
} finally {
  await prisma.$disconnect();
}
