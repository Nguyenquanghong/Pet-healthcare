import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const B1 = "48d01c3c95d136f808b846a66a75fe08aacd92be";

export function testDatabase(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("A synthetic PostgreSQL URL is required"); }
  const dbName = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^[a-z0-9_]+_test$/.test(dbName)) {
    throw new Error("Only a loopback PostgreSQL database ending _test is allowed");
  }
  return { dbName, host: parsed.hostname, port: parsed.port || "5432" };
}

export async function createOutputExclusive(path) {
  await mkdir(path, { recursive: false });
  return resolve(path);
}

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

export async function fingerprint(root, paths) {
  const digest = createHash("sha256");
  let count = 0;
  for (const item of paths) {
    const absolute = resolve(root, item);
    let files;
    try { files = await filesUnder(absolute); }
    catch (error) {
      if (error.code !== "ENOTDIR") throw error;
      files = [absolute];
    }
    for (const file of files.sort()) {
      digest.update(relative(root, file).replaceAll("\\", "/"));
      digest.update("\0");
      digest.update(await readFile(file));
      digest.update("\0");
      count++;
    }
  }
  return { sha256: digest.digest("hex"), fileCount: count };
}

export function processOutcome(code, signal, expectedStop = false) {
  const ok = code === 0 && signal === null;
  if (!ok) throw new Error(`Child ${expectedStop ? "stop" : "run"} failed: exit=${code} signal=${signal}`);
  return { exitCode: code, signal };
}

export async function gitAt(directory, args) {
  const child = spawn("git", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await new Promise((done) => child.once("exit", (...values) => done(values)));
  processOutcome(code, signal);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
