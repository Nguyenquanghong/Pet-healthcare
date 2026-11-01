import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../src");

// Tiers of backend/src and the tiers each may import (its own tier always). A directory the table does not name and a root
// file that is not an entry fail, so a new place for code is a decision made here. generated/ is the Prisma client: only
// infrastructure and workers reach it. The root files are entries: index.ts starts the composition, app.ts is the monolith
// that composition/coreApp.ts wraps, so composition may import app.ts and app.ts imports composition/http and coreRoutes.
const ALLOWED = {
  domain: ["domain"],
  application: ["domain", "application"],
  lib: ["domain", "lib"],
  infrastructure: ["domain", "application", "infrastructure", "lib", "generated"],
  middleware: ["domain", "lib", "middleware"],
  gateway: ["gateway"],
  routes: ["domain", "application", "lib", "middleware", "routes"],
  workers: ["domain", "application", "infrastructure", "lib", "workers", "composition", "generated"],
  composition: ["domain", "application", "lib", "infrastructure", "middleware", "gateway", "routes", "composition", "app.ts", "(outside src)"],
  "app.ts": ["domain", "composition"],
  "index.ts": ["composition", "lib"],
};
const STORAGE = /^(@prisma\/client|prisma|pg)(\/|$)/;
const CLIENTS = /^(express|@prisma\/client|prisma|pg|amqplib|ioredis|redis)(\/|$)/;
const GENERATED = /(^|\/)generated(\/|$)/;
const PRISMA_LIB = /(^|\/)lib\/prisma(\.js)?$/;
const FORBIDDEN = {
  domain: [CLIENTS, GENERATED],
  application: [CLIENTS, GENERATED],
  routes: [STORAGE, GENERATED, PRISMA_LIB],
  gateway: [STORAGE, GENERATED, PRISMA_LIB],
  middleware: [STORAGE, GENERATED, PRISMA_LIB],
  workers: [/^express(\/|$)/],
};
const NO_PRISMA_CALL = new Set(["routes", "gateway", "middleware"]);
// The one named exception: the account lookup types its parameter with the Prisma client, as a type only.
const TYPE_ONLY_EXCEPTIONS = new Map([["middleware/currentAccount.ts", "@prisma/client"]]);

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function imports(source) {
  const found = [];
  const pattern = /\b(?:import|export)\s+((?:[^;"']*?\s+from\s+)?)["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
  for (const match of withoutComments(source).matchAll(pattern)) {
    found.push({ specifier: match[2] ?? match[3], typeOnly: /^type\b/.test((match[1] ?? "").trim()) });
  }
  return found;
}

function tierOf(path) {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : path;
}

function violations(path, source, used = new Set()) {
  const tier = tierOf(path);
  if (!(tier in ALLOWED)) return [tier.endsWith(".ts") ? `${path} is in the src root but is not an entry file` : `${path}: ${tier}/ is not a tier of the Core`];
  const found = [];
  for (const { specifier, typeOnly } of imports(source)) {
    if (TYPE_ONLY_EXCEPTIONS.get(path) === specifier && typeOnly) {
      used.add(path);
      continue;
    }
    if (FORBIDDEN[tier]?.some((pattern) => pattern.test(specifier))) {
      found.push(`${path} imports ${specifier} (${tier} may not)`);
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const target = posix.normalize(posix.join(posix.dirname(path), specifier.replace(/\.js$/, ".ts")));
    const targetTier = target.startsWith("..") ? "(outside src)" : tierOf(target);
    if (targetTier !== tier && !ALLOWED[tier].includes(targetTier)) found.push(`${path} imports ${specifier} (${tier} may not import ${targetTier})`);
  }
  const code = withoutComments(source).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  if (NO_PRISMA_CALL.has(tier) && /\bprisma\s*\./.test(code)) found.push(`${path} calls Prisma directly`);
  return found;
}

const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === join(root, "generated")) continue;
    if (entry.isDirectory()) visit(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
}
visit(root);

const errors = [];
const used = new Set();
for (const file of files) {
  const path = relative(root, file).split(sep).join("/");
  errors.push(...violations(path, readFileSync(file, "utf8"), used));
}
for (const path of TYPE_ONLY_EXCEPTIONS.keys()) if (!used.has(path)) errors.push(`${path} no longer needs its named exception; remove it from TYPE_ONLY_EXCEPTIONS`);

const fixtures = [];
const rejects = (reason, path, source) => fixtures.push({ reason, path, source, count: 1 });
const accepts = (reason, path, source) => fixtures.push({ reason, path, source, count: 0 });
rejects("routes import infrastructure", "routes/internal/x.ts", 'import { a } from "../../infrastructure/a.js";');
rejects("routes import the storage client", "routes/internal/x.ts", 'import { PrismaClient } from "@prisma/client";');
rejects("routes import workers", "routes/internal/x.ts", 'import { a } from "../../workers/relay.js";');
rejects("routes import the generated client", "routes/x.ts", 'import { a } from "../generated/phase2-core/index.js";');
rejects("routes import the shared Prisma instance", "routes/x.ts", 'import { prisma } from "../lib/prisma.js";');
rejects("routes call Prisma", "routes/x.ts", "await prisma.user.findMany();");
rejects("routes import composition", "routes/dto/x.ts", 'import { a } from "../../composition/a.js";');
rejects("application imports lib", "application/x.ts", 'import { a } from "../lib/token.js";');
rejects("application imports the DTO", "application/x.ts", 'import { a } from "../routes/dto/a.js";');
rejects("application imports composition", "application/x.ts", 'import { a } from "../composition/a.js";');
rejects("application imports a messaging client", "application/x.ts", 'import { connect } from "amqplib";');
rejects("application imports the generated client", "application/x.ts", 'import { P } from "../generated/phase2-core/index.js";');
rejects("domain imports application", "domain/x.ts", 'import { a } from "../application/a.js";');
rejects("domain re-exports a storage type", "domain/x.ts", 'export type { Role } from "@prisma/client";');
rejects("domain imports express dynamically", "domain/x.ts", 'const a = await import("express");');
rejects("lib imports application", "lib/x.ts", 'import { a } from "../application/a.js";');
rejects("infrastructure imports workers", "infrastructure/x.ts", 'import { a } from "../workers/relay.js";');
rejects("infrastructure imports routes", "infrastructure/x.ts", 'import { a } from "../routes/a.js";');
rejects("gateway imports infrastructure", "gateway/x.ts", 'import { a } from "../infrastructure/a.js";');
rejects("workers import express", "workers/x.ts", 'import express from "express";');
rejects("composition imports workers", "composition/x.ts", 'import { a } from "../workers/a.js";');
rejects("composition imports the entry", "composition/x.ts", 'import { a } from "../index.js";');
rejects("middleware imports a route", "middleware/x.ts", 'import { a } from "../routes/a.js";');
rejects("middleware imports the storage client", "middleware/x.ts", 'import type { PrismaClient } from "@prisma/client";');
rejects("only the named file may import the client type", "middleware/currentAccount.ts", 'import { PrismaClient } from "@prisma/client";');
rejects("the entry reaches past composition", "index.ts", 'import { a } from "./infrastructure/a.js";');
rejects("a directory that is not a tier", "phase2/x.ts", "export const a = 1;");
rejects("a root file that is not an entry", "stray.ts", "export const a = 1;");
rejects("a source outside src", "routes/x.ts", 'import a from "../../openapi.json";');
accepts("domain", "domain/x.ts", 'import { b } from "./b.js"; import { c } from "./billing/c.js";');
accepts("application", "application/services/x.ts", 'import { a } from "../ports/a.js"; import { b } from "../../domain/b.js";');
accepts("lib", "lib/x.ts", 'import { a } from "../domain/a.js"; import jwt from "jsonwebtoken";');
accepts("infrastructure", "infrastructure/persistence/x.ts", 'import type { Prisma } from "@prisma/client"; import { a } from "../../application/ports/a.js"; import { b } from "../../lib/token.js"; import { P } from "../../generated/phase2-core/index.js"; import { c } from "../http/c.js";');
accepts("middleware", "middleware/x.ts", 'import { a } from "../lib/token.js"; import { b } from "../domain/b.js"; import { c } from "./c.js";');
accepts("middleware, the named client type", "middleware/currentAccount.ts", 'import type { PrismaClient } from "@prisma/client"; import { a } from "../lib/token.js";');
accepts("gateway", "gateway/x.ts", 'import type { Request } from "express"; import { a } from "./a.js";');
accepts("routes", "routes/x.ts", 'import express from "express"; import { a } from "../application/services/a.js"; import { b } from "../middleware/auth.js"; import { c } from "../lib/token.js"; import { d } from "./dto/d.js"; import { e } from "../domain/e.js";');
accepts("routes/internal", "routes/internal/x.ts", 'import { a } from "../../application/services/a.js"; import { b } from "../../lib/token.js"; import { c } from "../appointmentBilling.js";');
accepts("routes/dto", "routes/dto/x.ts", 'import type { A } from "../../application/ports/a.js"; import { b } from "./b.js"; import type { Actor } from "../../domain/auth.js";');
accepts("workers", "workers/x.ts", 'import { PrismaClient } from "@prisma/client"; import { P } from "../generated/phase2-core/index.js"; import { a } from "../composition/a.js"; import { b } from "../infrastructure/b.js"; import { c } from "./c.js";');
accepts("composition", "composition/x.ts", 'import express from "express"; import { a } from "../app.js"; import { b } from "../routes/b.js"; import { c } from "../infrastructure/c.js"; import { d } from "../gateway/d.js"; import { e } from "../middleware/e.js"; import openapi from "../../openapi.json";');
accepts("app.ts", "app.ts", 'import { a } from "./domain/a.js"; import { b } from "./composition/b.js"; import express from "express";');
accepts("index.ts", "index.ts", 'import { a } from "./composition/a.js"; import { b } from "./lib/b.js";');
accepts("a comment is not an import", "domain/x.ts", '// import { a } from "../application/a.js";\n/* import express from "express"; */');
for (const { reason, path, source, count } of fixtures) {
  const found = violations(path, source);
  if (found.length !== count) errors.push(`Negative fixture "${reason}" (${path}) found ${found.length} violation(s), expected ${count}: ${found.join("; ")}`);
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture boundary PASS: ${files.length} source files scanned in ${Object.keys(ALLOWED).length} tiers; ${fixtures.length} fixtures held.\n`);
}
