// Core domain app for the runtime composition: the shared routes with sanitized runtime
// errors. Keep the user's legacy entrypoint intact; route regression tests exercise
// this owned composition through createCoreApp.
import express from 'express';
import type { PrismaClient } from '@prisma/client';
import { BusinessError } from '../domain/error.js';
import { currentRequestId, isTransientFailure, reportUnexpected, requestFault } from '@nipopeto/runtime';
import { mountCoreRoutes } from './coreRoutes.js';
import { applyJsonBody } from './http.js';

export function createCoreDomains(client: PrismaClient, { clinical = true }: { clinical?: boolean } = {}) {
  const app = express();

  // createCoreApp's outer app sets the security headers and CORS; Express adds x-powered-by in every app it runs.
  app.disable('x-powered-by');
  applyJsonBody(app);

  // Auth is mounted by createCoreApp before these domains, with shared policy.
  mountCoreRoutes(app, client, { clinical });

  app.use((req, res) => res.status(404).json({ error: `Route ${req.originalUrl} was not found.` }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const fault = requestFault(error, {
      invalid: 'Request body must be valid JSON.',
      large: 'Request body is too large.',
      other: 'Request body could not be read.',
    });
    if (fault) {
      res.status(fault.status).json(fault.body);
      return;
    }
    if (isTransientFailure(error)) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Core unavailable. Retry the same request key.' });
      return;
    }
    res.status(500).json(reportUnexpected('core', error, currentRequestId()));
  });

  return app;
}
