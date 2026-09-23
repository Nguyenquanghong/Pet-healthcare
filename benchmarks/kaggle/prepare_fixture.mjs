import { writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../../backend/dist/src/lib/password.js";
import { signToken } from "../../backend/dist/src/lib/token.js";
import { prepareSyntheticFixture } from "./fixtureData.mjs";

// Fixture setup is outside the measured request mix. Creating >=100 owners through
// /api/auth/owner/register would hit the production 50-per-15-minute auth limiter.
const output = process.env.BENCH_FIXTURE;
const count = Number(process.env.BENCH_USERS || "100");
const seed = process.env.BENCH_SEED || "phase1";
const password = process.env.BENCH_PASSWORD;
if (!output || !password || !Number.isInteger(count) || count < 1) {
  throw new Error("BENCH_FIXTURE, BENCH_PASSWORD, and positive BENCH_USERS are required.");
}

const prisma = new PrismaClient();
try {
  const users = await prepareSyntheticFixture(prisma, { count, seed, password, hashPassword, signToken });
  await writeFile(output, JSON.stringify({ users }), { mode: 0o600 });
  process.stdout.write(`Prepared ${users.length} synthetic owner/pet pairs outside the measured API workload. Tokens were written only to the temporary fixture path.\n`);
} finally {
  await prisma.$disconnect();
}
