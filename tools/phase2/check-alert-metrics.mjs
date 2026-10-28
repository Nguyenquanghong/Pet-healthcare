// Fitness function: every alert rule in deploy/phase2/alerts.json refers to a metric that
// /metrics really exports, and the rules are documented. Read-only; no build needed.
//
// The exporter is ServiceRuntime.metrics() in packages/runtime/src/http.ts. It prints
// `pet_<name>` for each gauge('<name>', ...) and writes the pet_http_duration_seconds_*
// histogram lines literally. Core's extra hash_* gauges (backend/src/phase2/runtime.ts) are
// built at run time and are not alerted on, so that file is not an exporter source here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
export const exporterFiles = ['packages/runtime/src/http.ts'];
export const alertsFile = 'deploy/phase2/alerts.json';
export const documentFile = 'docs/phase2-architecture/10-observability.md';
const services = ['core', 'clinic', 'notification'];

// Exact names, never substrings: `pet_dlq` must not pass because `pet_dlq_ready` exists.
export function exportedMetrics(sources) {
  const names = new Set();
  for (const source of sources) {
    for (const m of source.matchAll(/\bgauge\('([a-z][a-z0-9_]*)'/g)) names.add('pet_' + m[1]);
    for (const m of source.matchAll(/\bpet_[a-z][a-z0-9_]*(?=\{)/g)) names.add(m[0]);
  }
  return names;
}

export function problems(alerts, exported, document = '') {
  const found = [];
  if (!Array.isArray(alerts?.rules) || !alerts.rules.length) return ['alerts.json has no rules'];
  const seen = new Set();
  for (const rule of alerts.rules) {
    const id = rule?.name ?? JSON.stringify(rule);
    for (const field of ['name', 'metric', 'condition', 'for', 'why'])
      if (typeof rule?.[field] !== 'string' || !rule[field].trim()) found.push(`${id}: missing ${field}`);
    if (typeof rule?.threshold !== 'number' || !Number.isFinite(rule.threshold)) found.push(`${id}: threshold must be a number`);
    if (!Array.isArray(rule?.service) || !rule.service.length || rule.service.some(s => !services.includes(s))) found.push(`${id}: service must list core, clinic or notification`);
    if (typeof rule?.name !== 'string') continue;
    if (seen.has(rule.name)) found.push(`${id}: duplicate name`);
    seen.add(rule.name);
    if (!/^\d+[smh]$/.test(rule.for ?? '')) found.push(`${id}: 'for' must look like 30s, 5m or 1h`);
    if (typeof rule.condition === 'string' && typeof rule.metric === 'string') {
      if (!rule.condition.includes(rule.metric)) found.push(`${id}: condition does not use its metric ${rule.metric}`);
      if (!new RegExp(`(?<![\\w.])${String(rule.threshold).replace('.', '\\.')}(?![\\w.])`).test(rule.condition)) found.push(`${id}: condition does not contain threshold ${rule.threshold}`);
      for (const used of new Set([rule.metric, ...(rule.condition.match(/\bpet_[a-z][a-z0-9_]*/g) ?? [])]))
        if (!exported.has(used)) found.push(`${id}: unknown metric ${used}`);
    }
    if (document && !document.includes(rule.name)) found.push(`${id}: not described in ${documentFile}`);
  }
  return found;
}

const read = path => readFileSync(resolve(root, path), 'utf8');

// Negative fixtures: the check must be able to fail.
{
  const exported = exportedMetrics([
    "gauge('dlq_ready', 1); gauge('queue_ready', 1); lines.push(`pet_http_duration_seconds_count{${labels}} ${n}`); lines.push(`pet_${name}{${label}} 1`);",
  ]);
  assert.deepEqual([...exported].sort(), ['pet_dlq_ready', 'pet_http_duration_seconds_count', 'pet_queue_ready']);
  // Per-target breaker series carry an extra label, so they are written out like the histogram.
  assert.ok(exportedMetrics(['lines.push(`pet_circuit_open{${label},target="${target}"} ${c.open}`)']).has('pet_circuit_open'));
  const rule = (metric, condition = `${metric} > 0`) => ({ name: 'Rule' + metric, metric, service: ['clinic'], condition, threshold: 0, for: '1m', why: 'x' });
  const check = (...rules) => problems({ rules }, exported);
  assert.deepEqual(check(rule('pet_dlq_ready')), []);
  assert.deepEqual(check(rule('pet_no_such_metric')), ['Rulepet_no_such_metric: unknown metric pet_no_such_metric']);
  assert.match(check(rule('pet_dlq'))[0], /unknown metric pet_dlq$/, 'a prefix of an exported name is not an exported name');
  assert.match(check(rule('dlq_ready'))[0], /unknown metric dlq_ready$/, 'the name without pet_ is not exported');
  assert.match(check(rule('pet_dlq_ready', 'pet_dlq_ready > 0 and pet_gone > 1'))[0], /unknown metric pet_gone/, 'a metric used only in the condition is checked too');
  assert.match(check(rule('pet_dlq_ready', 'pet_queue_ready > 0'))[0], /condition does not use its metric/);
  assert.match(check({ ...rule('pet_dlq_ready'), threshold: 9 })[0], /threshold 9/);
  assert.match(check({ ...rule('pet_dlq_ready'), for: 'soon' })[0], /'for' must look like/);
  assert.match(check({ ...rule('pet_dlq_ready'), service: ['billing'] })[0], /service must list/);
  assert.match(check(rule('pet_dlq_ready'), rule('pet_dlq_ready'))[0], /duplicate name/);
  assert.match(problems({ rules: [rule('pet_dlq_ready')] }, exported, 'no rule name here')[0], /not described in/);
  assert.deepEqual(problems({ rules: [] }, exported), ['alerts.json has no rules']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exported = exportedMetrics(exporterFiles.map(read));
  const alerts = JSON.parse(read(alertsFile));
  // The architecture docs are kept local (not committed), so CI checks metrics only.
  const found = problems(alerts, exported, existsSync(resolve(root, documentFile)) ? read(documentFile) : null);
  if (found.length) {
    process.stderr.write(`Alert rules FAIL (${alertsFile}):\n  ${found.join('\n  ')}\n`);
    process.exitCode = 1;
  } else {
    const used = new Set(alerts.rules.map(r => r.metric));
    console.log(`Alert rules PASS: ${alerts.rules.length} rules, ${used.size} metrics, all exported by ${exporterFiles.join(', ')}; ${exported.size} exported names, negative fixtures detected.`);
  }
}
