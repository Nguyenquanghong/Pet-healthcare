import express from 'express';
import type { Actor } from './domain/auth.js';
import { imageRetentionMs } from './infrastructure/blob/blobCleanup.js';
import type { CoreDirectory } from './infrastructure/core/directory.js';
import { mountBilling } from './http/billingApi.js';
import { errorHandler } from './http/errors.js';
import { appointmentRoutes } from './http/routes/appointments.js';
import { dashboardRoutes } from './http/routes/dashboard.js';
import { medicalRecordRoutes } from './http/routes/medicalRecords.js';
import { mountRoutes } from './http/scope.js';
import { blobStoreFromEnv, type BlobStore } from './infrastructure/blob/blobStore.js';
import { clinicUseCases, type ClinicDatabase } from './infrastructure/useCases.js';
import type { ServiceRuntime } from '@nipopeto/runtime';
import { requestActor } from '@nipopeto/runtime';

export function createApp(
  db: ClinicDatabase,
  verify?: (token: string) => Actor,
  source?: CoreDirectory,
  runtime?: ServiceRuntime,
  blobs: BlobStore = blobStoreFromEnv(),
) {
  imageRetentionMs(); // AQ-09: an invalid MEDICAL_IMAGE_RETENTION_DAYS fails at startup, not at the first delete
  const app = express();
  app.disable('x-powered-by');
  const useCases = clinicUseCases(db, blobs);
  app.locals.activity = useCases.activity;
  runtime?.install(app);
  mountBilling(app, useCases.billing, verify, source);
  app.get('/health/live', (_req, res) => res.json({ service: 'clinic', status: 'alive' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await useCases.readiness.check();
      res.json({ service: 'clinic', status: 'ready' });
    } catch {
      res.status(503).json({ service: 'clinic', status: 'unavailable' });
    }
  });
  const router = express.Router();
  router.use('/dashboard/clinic/activity', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use((req, res, next) => {
    if (!verify || !source) {
      res.status(503).json({ error: 'Clinic authentication or directory is not configured.' });
      return;
    }
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith('Bearer ') || bearer.length > 8192) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    try {
      res.locals.actor = requestActor(req, verify);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
    }
  });
  router.use(express.json({ limit: '8mb' }));
  // Each route carries its own policy enforcement point (permission, body, pets and doctor, Core), declared in its registry.
  mountRoutes(
    router,
    [...appointmentRoutes(useCases), ...medicalRecordRoutes(useCases), ...dashboardRoutes(useCases)],
    {
      source,
      lookup: useCases.scopeLookup,
    },
  );
  app.use('/api', router);
  app.use((_req, res) => res.status(404).json({ error: 'Clinic route not found.' }));
  app.use(errorHandler);
  return app;
}
