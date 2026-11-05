import express from 'express';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../legacy/app.js';
import { coreConfigFromEnv, coreSettings, servesClinical, type CoreConfig } from './config.js';
import { applySecurity } from './http.js';
import { mountSplitRoutes } from './coreRoutes.js';
import { coreRuntime } from './runtime.js';
import { createCoreDomains } from './coreDomains.js';
import { requestFault } from '@nipopeto/runtime';
import { currentAccount } from '../middleware/currentAccount.js';

// Keep the user's app.ts intact. This composition owns the split service route
// and the private Core authorization endpoint before mounting existing domains.
export function createCoreApp(db: PrismaClient, config: CoreConfig = coreConfigFromEnv()) {
  const settings = coreSettings(config);
  const app = express();
  applySecurity(app, { exposedHeaders: ['X-Service-Degraded', 'Retry-After'] });
  const runtime = coreRuntime(db);
  runtime?.install(app);
  app.use('/api', currentAccount(db));
  mountSplitRoutes(app, db, settings, Boolean(runtime));
  const clinical = servesClinical(settings);
  // The app behind the split routes, kept so a test can send requests to it without the Clinic proxy in front.
  app.locals.domains = runtime ? createCoreDomains(db, { clinical }) : createApp(db, { clinical });
  app.use(app.locals.domains);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const text = 'Request unavailable or invalid.';
    const fault = requestFault(error, { invalid: text, large: text, other: text });
    res.status(fault?.status ?? 503).json({ error: text });
  });
  return app;
}
