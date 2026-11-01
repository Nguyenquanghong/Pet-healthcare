// The production Core composition (createCoreApp) boots the shared runtime when REDIS_URL is set. These helpers give a test that
// runtime without Redis or a database: the readiness probe answers from a snapshot and the limiter counts in memory.
const idle = {
  pending: 0,
  outboxAgeSeconds: 0,
  outboxRetries: 0,
  billingPending: 0,
  billingAgeSeconds: 0,
  dbLockWaits: 0,
};

// The same values on every call, so a test that restarts its app keeps the tokens it already signed.
export function coreTestEnv() {
  for (const key of [
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'JWT_KEY_ID',
    'PHASE2_RUNTIME_REQUIRED',
  ])
    delete process.env[key];
  Object.assign(process.env, {
    JWT_SECRET: 'core-composition-fixture-jwt-secret-0123456789abcdef',
    OBSERVABILITY_TOKEN: 'metrics-fixture-'.repeat(3),
    RATE_LIMIT_KEY_SECRET: 'limiter-fixture-'.repeat(3),
    REDIS_URL: 'redis://127.0.0.1:1',
    RATE_LIMIT_NAMESPACE: 'core-composition-test',
  });
}

// The runtime's own readiness probe is the one transaction with maxWait 1500; every other transaction goes to `db`.
export const probeAware = (db, snapshot = idle) =>
  new Proxy(db, {
    get: (target, key) =>
      key === '$transaction'
        ? (work, options) =>
            options?.maxWait === 1500 ? Promise.resolve(snapshot) : target.$transaction(work, options)
        : Reflect.get(target, key),
  });

// Call after createCoreApp and before the first request; the caller closes the returned runtime in `finally`.
export async function localLimiter(app) {
  const rt = app.locals.runtime;
  rt.limiter.spend = async (group, buckets) => rt.limiter.localRead(group, buckets);
  rt.limiter.ping = async () => true;
  rt.brokerProbe = async () => true;
  await rt.start();
  return rt;
}
