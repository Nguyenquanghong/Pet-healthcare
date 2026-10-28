import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// backend/package.json sits two directories above this file under tsx and three above the built one,
// so look upward for it instead of assuming either layout.
function readVersion() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@nipopeto/backend" && typeof pkg.version === "string") return pkg.version;
    } catch {}
  }
  return "unknown";
}

export const serviceVersion = readVersion();
