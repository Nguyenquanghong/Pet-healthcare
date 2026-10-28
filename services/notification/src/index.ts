import { createApp } from './app.js';
import { actorVerifier } from './auth.js';
import { createDependencies } from './composition.js';
import { credential, installShutdown } from '@nipopeto/runtime';
import { CoreSendAuthorization } from './coreAuthorization.js';
import { notificationRuntime } from './runtime.js';
const { db } = createDependencies();
try {
  await db.$connect();
  const verify = process.env.JWT_PUBLIC_KEY
    ? actorVerifier({
        publicKey: process.env.JWT_PUBLIC_KEY,
        issuer: process.env.JWT_ISSUER ?? '',
        audience: process.env.JWT_AUDIENCE ?? '',
      })
    : undefined;
  const strict = process.env.PHASE2_RUNTIME_REQUIRED === '1';
  if (strict && (!verify || !process.env.JWT_KEY_ID || process.env.JWT_PRIVATE_KEY || process.env.JWT_SECRET))
    throw new Error('VERIFIER_ONLY_CONFIGURATION_REQUIRED');
  const token = strict
    ? credential('CORE_NOTIFICATION_SEND_TOKEN')
    : (process.env.CORE_NOTIFICATION_SEND_TOKEN ?? process.env.NOTIFICATION_SERVICE_TOKEN);
  if (Boolean(process.env.CORE_SERVICE_URL) !== Boolean(token)) throw new Error('INCOMPLETE_CORE_AUTH_CONFIGURATION');
  const authorization = process.env.CORE_SERVICE_URL
    ? new CoreSendAuthorization(process.env.CORE_SERVICE_URL, token!)
    : undefined;
  const runtime = verify ? notificationRuntime(db, verify) : undefined;
  const app = createApp(db, verify, authorization, runtime);
  await runtime?.start();
  const server = app.listen(Number(process.env.PORT || 5102), process.env.HOST || '127.0.0.1', () =>
    process.stdout.write(JSON.stringify({ service: 'notification', status: 'api-ready' }) + '\n'),
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  installShutdown('notification', async () => {
    if (runtime) await runtime.drain(server, () => db.$disconnect());
    else {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await db.$disconnect();
    }
  });
} catch {
  process.stderr.write(JSON.stringify({ service: 'notification', code: 'STARTUP_FAILED' }) + '\n');
  await db.$disconnect();
  process.exitCode = 1;
}
