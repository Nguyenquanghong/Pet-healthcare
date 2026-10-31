import express from 'express';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import { authorize } from './domain/authorization.js';
import { imageRetentionMs } from './infrastructure/blob/blobCleanup.js';
import { objectInput } from './domain/validation.js';
import { CoreDirectory, RequestDirectory, DeferredDirectory, failClosed } from './infrastructure/core/directory.js';
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
  router.use((req, _res, next) => {
    if (req.path === '/dashboard/clinic/activity') authorize(_res.locals.actor, 'clinic-activity.read');
    next();
  });
  router.use(legacyRequestScope(db, source));
  mountRoutes(router, [...appointmentRoutes(useCases), ...medicalRecordRoutes(useCases), ...dashboardRoutes(useCases)]);
  app.use('/api', router);
  app.use((_req, res) => res.status(404).json({ error: 'Clinic route not found.' }));
  app.use(errorHandler);
  return app;
}

const deferredReads = new Set(['/appointments', '/medical-records', '/medical-records/images']);
// What decides, from the URL alone, which pets and which doctor Core is asked about before a handler runs. The routes
// already declare what this reads from the path (resource, writePermission, deferred, ignoreQueryPetId, trimBodyPetId);
// the commit that makes them the source replaces this function.
function legacyRequestScope(db: ClinicDatabase, source: CoreDirectory | undefined): express.RequestHandler {
  return async (req, res, next) => {
    const actor = res.locals.actor as Actor;
    if (req.path.startsWith('/medical-records') && req.method !== 'GET') authorize(actor, 'medical-record.write');
    if (req.body === undefined && ['POST', 'PATCH', 'PUT'].includes(req.method)) req.body = {};
    if (req.body !== undefined) objectInput(req.body);
    const petIds: string[] = [];
    const add = (v: unknown) => {
      if (v !== undefined && v !== null && v !== '') {
        if (typeof v !== 'string' || v.length > 200) throw new BusinessError(422, 'Invalid pet ID.');
        petIds.push(v);
      }
    };
    if (req.method === 'GET') {
      if (req.path !== '/dashboard/clinic/activity') {
        const id = typeof req.query.petId === 'string' ? req.query.petId.trim() : req.query.petId;
        if (id !== 'all') add(id);
      }
    } else
      add(
        req.path === '/medical-records' && typeof req.body?.petId === 'string'
          ? req.body.petId.trim()
          : req.body?.petId,
      );
    const match = req.path.match(/^\/(appointments|medical-records)\/(?:images\/)?([^/]+)(?:\/|$)/);
    if (match && !['calendar', 'images', 'availability'].includes(match[2]!)) {
      const id = decodeURIComponent(match[2]!);
      let row: { petId: string } | null =
        match[1] === 'appointments'
          ? await db.appointment.findUnique({ where: { id } })
          : req.path.startsWith('/medical-records/images/')
            ? await db.medicalImage.findUnique({ where: { id }, select: { petId: true } })
            : await db.medicalRecord.findUnique({ where: { id } });
      // AQ-15: history outlives a deleted record; scope it by the pet in its last snapshot.
      if (!row && req.method === 'GET' && req.path === `/medical-records/${match[2]}/history`) {
        const last = await db.medicalRecordRevision.findFirst({
          where: { recordId: id },
          orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        });
        const snapshot = (last?.before ?? last?.after) as { petId?: unknown } | null | undefined;
        if (typeof snapshot?.petId === 'string') row = { petId: snapshot.petId };
      }
      if (!row) throw new BusinessError(404, 'Clinic resource not found.');
      add(row.petId);
    }
    const token = req.headers.authorization!.slice(7);
    // Deferred authorization: these list GETs query first and ask Core once afterwards (authorizedRead). Every other route, and any state but a closed breaker, asks Core before touching the database.
    if (req.method === 'GET' && deferredReads.has(req.path) && source!.breaker?.state === 'closed') {
      const directory = new DeferredDirectory(source!, actor, token, [...new Set(petIds)]);
      failClosed(res, directory);
      res.locals.directory = directory;
      next();
      return;
    }
    const snapshot = await source!.request(actor, token, {
      petIds: [...new Set(petIds)],
      ...(req.body?.doctorId ? { doctorId: req.body.doctorId } : {}),
    });
    res.locals.directory = new RequestDirectory(source!, actor, token, snapshot);
    next();
  };
}
