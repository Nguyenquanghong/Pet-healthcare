import http from "node:http";
import { performance } from "node:perf_hooks";

const mixes = {
  balanced: { bootstrap: 30, pets: 20, appointments: 15, medical: 10, hotel: 10, inbox: 10, book: 5 },
  "inbox-hot": { inbox: 70, bootstrap: 15, read: 5, pets: 5, book: 5 },
  "business-hot": { appointments: 60, book: 20, bootstrap: 10, inbox: 10 },
};

export function actions(profile, owners, seed = 20260928) {
  const mix = mixes[profile];
  if (!mix) throw new Error(`Unknown profile: ${profile}`);
  const plan = Object.entries(mix).flatMap(([kind, count]) => Array.from({ length: count }, () => kind));
  let random = seed >>> 0;
  for (let i = plan.length - 1; i > 0; i--) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const j = random % (i + 1);
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  let booking = 0; let read = 0;
  return plan.map((kind, index) => {
    const ownerIndex = index % owners.length;
    const owner = owners[ownerIndex];
    const result = { id: index, kind, token: owner.token, method: "GET", path: "/api/bootstrap", expectedStatus: 200 };
    if (kind === "pets") result.path = "/api/pets";
    if (kind === "appointments") result.path = "/api/appointments";
    if (kind === "medical") result.path = "/api/medical-records";
    if (kind === "hotel") result.path = "/api/hotel-bookings";
    if (kind === "inbox") result.path = "/api/notifications";
    if (kind === "read") {
      result.method = "PATCH";
      result.path = `/api/notifications/phase2-notification-${ownerIndex}-${read++ % 20}/read`;
    }
    if (kind === "book") {
      result.method = "POST";
      result.path = "/api/appointments";
      result.expectedStatus = 201;
      result.body = { petId: owner.petId, type: "general_checkup", serviceName: "Phase2 screening", date: `2035-01-${String(++booking).padStart(2, "0")}`, time: "09:00" };
    }
    return result;
  });
}

export async function startProxy(upstreamPorts) {
  let next = 0;
  const stats = { requests: 0, statuses: {}, maxActive: 0, active: 0, requestBytes: 0, responseBytes: 0 };
  const server = http.createServer((req, res) => {
    const port = upstreamPorts[next++ % upstreamPorts.length];
    stats.requests++; stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
    const upstream = http.request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (remote) => {
      res.writeHead(remote.statusCode || 502, remote.headers);
      remote.on("data", (chunk) => { stats.responseBytes += chunk.length; });
      remote.pipe(res);
    });
    upstream.setTimeout(5000, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on("data", (chunk) => { stats.requestBytes += chunk.length; });
    req.pipe(upstream);
    let finished = false;
    const done = () => { if (finished) return; finished = true; stats.active--; stats.statuses[res.statusCode] = (stats.statuses[res.statusCode] || 0) + 1; };
    res.once("finish", done); res.once("close", done);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, stats, close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
}

async function send(port, action) {
  const payload = action.body ? JSON.stringify(action.body) : "";
  const started = performance.now();
  return new Promise((resolve) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: action.path, method: action.method, headers: {
      authorization: `Bearer ${action.token}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
    } }, (response) => {
      let responseBytes = 0;
      const bookingChunks = [];
      response.on("data", (chunk) => { responseBytes += chunk.length; if (action.kind === "book") bookingChunks.push(chunk); });
      response.on("end", () => {
        let appointmentId;
        if (action.kind === "book") {
          try { appointmentId = JSON.parse(Buffer.concat(bookingChunks).toString("utf8")).appointment?.id; } catch { /* invalid response is checked by reconciliation */ }
        }
        resolve({ id: action.id, kind: action.kind, method: action.method, path: action.path, status: response.statusCode, expectedStatus: action.expectedStatus, durationMs: performance.now() - started, requestBytes: Buffer.byteLength(payload), responseBytes, ...(action.kind === "book" ? { appointmentId: appointmentId || null } : {}) });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("client timeout")));
    request.on("error", (error) => resolve({ id: action.id, kind: action.kind, method: action.method, path: action.path, status: null, expectedStatus: action.expectedStatus, durationMs: performance.now() - started, requestBytes: Buffer.byteLength(payload), responseBytes: 0, error: error.message }));
    request.end(payload);
  });
}

export async function runActions(port, plan, concurrency = 10) {
  let cursor = 0;
  const rows = new Array(plan.length);
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < plan.length) {
      const index = cursor++;
      rows[index] = await send(port, plan[index]);
    }
  }));
  return { rows, elapsedMs: performance.now() - started };
}

export function summarize(rows, elapsedMs) {
  const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  const percentile = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] ?? null;
  const statuses = {};
  for (const row of rows) statuses[String(row.status ?? "transport-error")] = (statuses[String(row.status ?? "transport-error")] || 0) + 1;
  const perAction = {};
  for (const kind of new Set(rows.map((row) => row.kind))) {
    const subset = rows.filter((row) => row.kind === kind);
    const sorted = subset.map((row) => row.durationMs).sort((a, b) => a - b);
    perAction[kind] = { count: subset.length, unexpected: subset.filter((row) => row.status !== row.expectedStatus).length,
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null };
  }
  return { count: rows.length, unexpected: rows.filter((row) => row.status !== row.expectedStatus).length, statuses,
    elapsedMs, achievedRps: rows.length / (elapsedMs / 1000), p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    requestBytes: rows.reduce((sum, row) => sum + row.requestBytes, 0), responseBytes: rows.reduce((sum, row) => sum + row.responseBytes, 0), perAction };
}
