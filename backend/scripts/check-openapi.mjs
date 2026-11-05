import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";

const backend = resolve(import.meta.dirname, "..");
const spec = JSON.parse(readFileSync(resolve(backend, "openapi.json"), "utf8"));
await SwaggerParser.validate(spec);
const basePath = spec.servers?.[0]?.url;
assert.equal(basePath, "/api", "OpenAPI must declare the shared /api base URL");

const mounts = {
  auth: "/api/auth", public: "/api/public",
  pets: "/api/pets", owners: "/api/owners", appointments: "/api/appointments", medicalRecords: "/api/medical-records",
  hotelBookings: "/api/hotel-bookings", hotelCapacity: "/api/hotel-capacity", notifications: "/api/notifications", invoices: "/api/invoices",
  payments: "/api/payments", lists: "/api",
};
const legacyRouters = new Set(["appointments", "medicalRecords", "notifications"]);
const runtime = new Set(["GET /api/health"]);
assert.match(readFileSync(resolve(backend,'src/routes/appointmentBilling.ts'),'utf8'),/app\.get\(\s*'\/api\/operations\/:id'/);
runtime.add('GET /api/operations/{id}');
// The Core dashboard is in routes/dashboard.ts; the clinic dashboard is legacy's, in legacy/routes/clinicDashboard.ts.
const dashboardSource=['src/routes/dashboard.ts','src/legacy/routes/clinicDashboard.ts'].map(file=>readFileSync(resolve(backend,file),'utf8')).join('\n');
for(const match of dashboardSource.matchAll(/app\.get\(\s*'([^']+)'/g))runtime.add('GET '+match[1]);
for (const [file, mount] of Object.entries(mounts)) {
  // The Phase 1 routers live in src/legacy/routes; the rest are Core's own. The list router's clinical GETs are in
  // src/legacy/routes/clinicalLists.ts, mounted at the same /api.
  const dir = legacyRouters.has(file) ? "src/legacy/routes" : "src/routes";
  const sources = [resolve(backend, dir, `${file}.ts`), ...(file === "lists" ? [resolve(backend, "src/legacy/routes/clinicalLists.ts")] : [])];
  const source = sources.map(path => readFileSync(path, "utf8")).join("\n");
  for (const match of source.matchAll(/\brouter\.(get|post|patch|put|delete)\(\s*["']([^"']+)["']/g)) {
    const path = (mount + (match[2] === "/" ? "" : match[2])).replace(/:([A-Za-z][\w]*)/g, "{$1}");
    runtime.add(`${match[1].toUpperCase()} ${path}`);
  }
}
const documented = new Set();
// Clinic declares each route as an element of its registry, `{ method: 'get', path: '/x', ...`, in http/routes/*.ts.
const clinicRoutes=resolve(backend,'../services/clinic/src/http/routes');
const clinicRouteFiles=readdirSync(clinicRoutes).filter(file=>file.endsWith('.ts')).sort();
assert.ok(clinicRouteFiles.length>0,'Clinic route files not found');
for(const file of clinicRouteFiles)for(const match of readFileSync(resolve(clinicRoutes,file),'utf8').matchAll(/\{\s*method:\s*'(get|post|patch|put|delete)',\s*path:\s*'([^']+)'/g)){
  runtime.add(`${match[1].toUpperCase()} /api${match[2].replace(/:([A-Za-z][\w]*)/g,'{$1}')}`);
}
// Core entrypoint composes the independently owned Notification public router.
// Include routes from its source, not just its spec, in the public inventory.
assert.match(readFileSync(resolve(backend, 'src/composition/coreRoutes.ts'), 'utf8'), /app\.use\(\s*'\/api\/notifications',\s*express\.json\(/);
assert.match(readFileSync(resolve(backend, 'src/index.ts'), 'utf8'), /createCoreApp/);
const notificationSource = readFileSync(resolve(backend, '../services/notification/src/app.ts'), 'utf8');
for (const match of notificationSource.matchAll(/\brouter\.(get|post|patch|put|delete)\(\s*['"]([^'"]+)['"]/g)) {
  const path = ('/api/notifications' + (match[2] === '/' ? '' : match[2])).replace(/:([A-Za-z][\w]*)/g, '{$1}');
  runtime.add(`${match[1].toUpperCase()} ${path}`);
}
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    documented.add(`${method.toUpperCase()} ${basePath}${path}`);
    assert.ok(operation.operationId && operation.summary, `${method} ${path} needs operation metadata`);
    assert.ok(operation.responses.default?.content?.["application/json"]?.schema, `${method} ${path} needs JSON error`);
    assert.ok(operation.security?.length || operation.security?.length === 0, `${method} ${path} needs explicit auth contract`);
    for (const requirement of operation.security) {
      for (const scheme of Object.keys(requirement)) {
        assert.ok(Object.hasOwn(spec.components?.securitySchemes ?? {}, scheme), `${method} ${path} references undefined security scheme ${scheme}`);
      }
    }
    if (operation.requestBody) assert.ok(operation.requestBody.content?.["application/json"]?.schema, `${method} ${path} needs JSON request schema`);
    for (const [code, response] of Object.entries(operation.responses)) {
      if (/^2\d\d$/.test(code) && code !== "204") assert.ok(response.content?.["application/json"]?.schema, `${method} ${path} needs JSON success schema`);
    }
  }
}
assert.deepEqual([...documented].sort(), [...runtime].sort(), "OpenAPI routes differ from mounted runtime routes");
assert.equal(runtime.size, 75, "P2 unread-count, P4 operations, P5 dashboard regions, D1 Clinic activity, AQ-15 medical record history, AQ-09 image restore, AQ-10 hotel capacity, P11 doctor list and P10 availability preserve the original 65 operations");
process.stdout.write(`OpenAPI PASS: ${runtime.size} operations match source and schemas validate.\n`);
