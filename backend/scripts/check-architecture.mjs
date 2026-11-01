import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../src");
const protectedRoots = [join(root, "domain"), join(root, "application")];
const routesRoot = join(root, "routes");
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (extname(path) === ".ts") files.push(path);
  }
}
visit(root);

function imports(source, filename) {
  const found = [];
  const pattern = /\b(?:import|export)\s+(?:[^;"']*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    found.push(match[1] ?? match[2]);
  }
  return found;
}

const forbidden = /^(express|@prisma\/client|prisma|pg)(\/|$)/;
const persistenceForbidden = /^(@prisma\/client|prisma|pg)(\/|$)/;
const errors = [];
for (const file of files.filter((path) => protectedRoots.some((directory) => path.startsWith(directory + "\\") || path.startsWith(directory + "/")))) {
  for (const specifier of imports(readFileSync(file, "utf8"), file)) {
    if (forbidden.test(specifier)) errors.push(`${relative(root, file)} imports ${specifier}`);
    if (specifier.startsWith(".")) {
      const target = resolve(file, "..", specifier.replace(/\.js$/, ".ts"));
      if (!protectedRoots.some((directory) => target.startsWith(directory + "\\") || target.startsWith(directory + "/"))) errors.push(`${relative(root, file)} crosses layer to ${specifier}`);
    }
  }
}

// K3 C2 moved these files into routes/ unchanged. Each still reaches Prisma or infrastructure until it is split
// (directory C5, dashboard C7; billing left in C4b). A file that no longer violates must leave this list, and a name that no
// longer exists is stale; the list is gone when C10 replaces this script by the tier table.
const PENDING_SPLIT = new Set(["routes/internal/directory.ts", "routes/dashboard.ts"]);
const seenPending = new Set();
for (const file of files.filter((path) => path.startsWith(routesRoot + "\\") || path.startsWith(routesRoot + "/"))) {
  const source = readFileSync(file, "utf8");
  const name = relative(root, file).replaceAll("\\", "/");
  const violations = [];
  for (const specifier of imports(source, file)) {
    if (persistenceForbidden.test(specifier) || /(?:^|\/)lib\/prisma(?:\.js)?$|(?:^|\/)infrastructure\//.test(specifier)) violations.push(`${name} accesses persistence through ${specifier}`);
  }
  if (/\bprisma\s*\./.test(source)) violations.push(`${name} calls Prisma directly`);
  if (PENDING_SPLIT.has(name)) {
    seenPending.add(name);
    if (!violations.length) errors.push(`${name} no longer violates the route rule; remove it from PENDING_SPLIT`);
  } else errors.push(...violations);
}
for (const name of PENDING_SPLIT) if (!seenPending.has(name)) errors.push(`${name} in PENDING_SPLIT does not exist`);
const negativeFixture = imports('export type { Role } from "@prisma/client"; import("express");', "negative.ts");
if (negativeFixture.filter((item) => forbidden.test(item)).length !== 2) errors.push("Negative fixture did not detect forbidden type re-export and dynamic import.");

if (errors.length) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture boundary PASS: ${files.length} source files scanned; negative fixture detected.\n`);
}
