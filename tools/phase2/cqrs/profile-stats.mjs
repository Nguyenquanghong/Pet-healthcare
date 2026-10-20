import assert from 'node:assert/strict';

export function profileArgs(args) {
  assert.ok(args.length === 3 && args[0] === '--run' && args[1] === '--fixture', 'Use --help');
  assert.match(args[2], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'Expected trial UUID v4');
  return {fixture: args[2], warmupSeconds: 30, measuredSeconds: 120, arrivalRate: 20, concurrency: 4, poolSize: 4};
}

export function distribution(values) {
  assert.ok(values.every(n => Number.isFinite(n) && n >= 0), 'Invalid measurement');
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null};
}

export function cpuDelta(before, after, elapsedMs, successes) {
  const usec = after - before;
  assert.ok(Number.isFinite(usec) && usec >= 0 && elapsedMs > 0 && successes >= 0, 'Invalid CPU interval');
  return {cpuSeconds: usec / 1e6, percentOfOneCore: usec / (elapsedMs * 10),
    cpuMsPerSuccess: successes ? usec / 1000 / successes : null};
}
