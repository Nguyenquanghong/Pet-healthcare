import {test} from 'node:test';
import assert from 'node:assert/strict';
import {profileArgs, distribution, cpuDelta} from './profile-stats.mjs';

test('profiling refuses paths, incomplete CLI, non-v4 IDs and workload overrides', () => {
  for (const args of [[], ['--run'], ['--run', '--fixture', '../main'],
    ['--run', '--fixture', '00000000-0000-0000-0000-000000000000'],
    ['--run', '--fixture', '6606fa4c-5ee3-48e1-b446-8b12c7d29e2c', '--rate', '1000']]) {
    assert.throws(() => profileArgs(args));
  }
  assert.equal(profileArgs(['--run', '--fixture', '6606fa4c-5ee3-48e1-b446-8b12c7d29e2c']).arrivalRate, 20);
});
test('nearest-rank percentiles handle empty data without inventing zero latency', () => {
  assert.deepEqual(distribution([]), {samples: 0, p50: null, p95: null, p99: null, max: null});
  assert.equal(distribution(Array.from({length: 100}, (_, i) => 100 - i)).p95, 95);
  assert.throws(() => distribution([NaN]));
});
test('CPU normalization counts microseconds and supports more than one core', () => {
  assert.deepEqual(cpuDelta(1000, 4001000, 2000, 200), {cpuSeconds: 4, percentOfOneCore: 200, cpuMsPerSuccess: 20});
  assert.equal(cpuDelta(0, 0, 10, 0).cpuMsPerSuccess, null);
  assert.throws(() => cpuDelta(10, 9, 100, 1));
});
