import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOutputExclusive, processOutcome, testDatabase } from "./common.mjs";
import { actions, summarize } from "./workload.mjs";

test("reject output reuse and unsafe DB targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pet-healthcare-p2-harness-"));
  try {
    const target = join(root, "one-run");
    await createOutputExclusive(target);
    await assert.rejects(createOutputExclusive(target), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(testDatabase("postgresql://synthetic:synthetic@127.0.0.1:5432/phase2_test").dbName, "phase2_test");
  assert.throws(() => testDatabase("postgresql://synthetic:synthetic@db.example/phase2_test"));
  assert.throws(() => testDatabase("postgresql://synthetic:synthetic@127.0.0.1/pet_healthcare"));
});

test("a killed real child is not a successful run", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  child.kill();
  const { code, signal } = await exited;
  assert.throws(() => processOutcome(code, signal), /failed/);
});

test("same deterministic logical actions for variants and exact mixes", () => {
  const owners = Array.from({ length: 10 }, (_, i) => ({ token: `synthetic-token-${i}`, petId: `pet-${i}` }));
  const balanced = actions("balanced", owners);
  const hot = actions("inbox-hot", owners);
  assert.deepEqual(balanced, actions("balanced", owners));
  assert.equal(balanced.length, 100);
  assert.equal(balanced.filter((action) => action.kind === "book").length, 5);
  assert.equal(hot.filter((action) => action.kind === "inbox").length, 70);
  assert.equal(hot.filter((action) => action.kind === "read").length, 5);
  assert.equal(summarize([{ status: 200, expectedStatus: 200, durationMs: 1, requestBytes: 0, responseBytes: 1 }, { status: 503, expectedStatus: 200, durationMs: 2, requestBytes: 0, responseBytes: 0 }], 1000).unexpected, 1);
});
