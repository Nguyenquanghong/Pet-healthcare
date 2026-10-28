import express, { type ErrorRequestHandler } from 'express';
import type { PrismaClient } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError, StaleRevision } from './domain/error.js';
import type { MedicalRecordValue } from './application/ports/medicalRecords.js';
import { authorize } from './domain/authorization.js';
import { imageRetentionMs } from './blobCleanup.js';
import { objectInput, calendarDate, requiredText } from './domain/validation.js';
import { CoreDirectory, RequestDirectory, DeferredDirectory, failClosed } from './directory.js';
import { AppointmentService } from './application/services/appointments.js';
import { MedicalRecordsService, medicalFields } from './application/services/medicalRecords.js';
import { appointmentTypes } from './application/ports/appointments.js';
import { BookingLifecycleService } from './application/services/bookingLifecycle.js';
import {
  appointmentDependencies,
  medicalDependencies,
  Lifecycle,
  medicalMutation,
} from './infrastructure/persistence/repositories.js';
import { appointmentDto, medicalRecordDto } from './lib/serialize.js';
import { deduplicated } from './dedup.js';
import { list } from './infrastructure/queries/authoritativeLists.js';
import { AuthoritativeAppointmentQueries } from './infrastructure/queries/authoritativeAppointments.js';
import { bootstrap } from './bootstrap.js';
import { parseActivityFilter } from './application/queries/clinicActivity.js';
import { ClinicActivityQueries } from './infrastructure/queries/clinicActivity.js';
import { mountBilling } from './billingApi.js';
import { blobStoreFromEnv, type BlobStore } from './blobStore.js';
import type { ServiceRuntime } from '@nipopeto/runtime';
import { currentRequestId, isTransientFailure, reportUnexpected, requestActor } from '@nipopeto/runtime';

export function createApp(
  db: PrismaClient,
  verify?: (token: string) => Actor,
  source?: CoreDirectory,
  runtime?: ServiceRuntime,
  blobs: BlobStore = blobStoreFromEnv(),
) {
  imageRetentionMs(); // AQ-09: an invalid MEDICAL_IMAGE_RETENTION_DAYS fails at startup, not at the first delete
  const app = express();
  app.disable('x-powered-by');
  const authoritative = new AuthoritativeAppointmentQueries(db);
  // Activity mode is server configuration (source or cached), never a client parameter.
  const activity = new ClinicActivityQueries(db, (process.env.CLINIC_ACTIVITY_MODE ?? 'source') as 'source' | 'cached');
  app.locals.activity = activity;
  runtime?.install(app);
  mountBilling(app, db, verify, source);
  app.get('/health/live', (_req, res) => res.json({ service: 'clinic', status: 'alive' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await db.appointment.count();
      await db.medicalRecord.count();
      await db.medicalImage.count();
      await db.requestDedup.count();
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
  const deferredReads = new Set(['/appointments', '/medical-records', '/medical-records/images']);
  router.use(async (req, res, next) => {
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
  });
  const appointment = (res: express.Response, bound?: Parameters<typeof appointmentDependencies>[2]) =>
    new AppointmentService(
      appointmentDependencies(db, res.locals.directory, bound),
      new BookingLifecycleService(new Lifecycle(db, res.locals.directory, bound)),
    );
  const medical = (res: express.Response, bound?: Parameters<typeof medicalDependencies>[3]) =>
    new MedicalRecordsService(medicalDependencies(db, res.locals.directory, blobs, bound));
  const read = async (run: (reader: AuthoritativeAppointmentQueries) => Promise<unknown>, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store');
    return await run(authoritative);
  };
  // A deferred list answers only after Core authorized the request; a Core refusal (401/403/503) outranks a local error.
  const authorizedRead = async (res: express.Response, compute: () => Promise<unknown>) => {
    const directory = res.locals.directory,
      settle = () => (directory instanceof DeferredDirectory ? directory.settle() : undefined);
    let body: unknown;
    try {
      body = await compute();
    } catch (error) {
      await settle();
      throw error;
    }
    await settle();
    res.json(body);
  };
  const sendMutation = (res: express.Response, response: unknown, status = 200) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(response);
  };
  router.get('/appointments', async (req, res) =>
    authorizedRead(res, () => read(reader => reader.list(res.locals.actor, res.locals.directory, req.query), res)),
  );
  router.get('/appointments/calendar', async (req, res) =>
    res.json(
      await read(
        reader => reader.calendar(res.locals.actor, { month: req.query.month, category: req.query.category }),
        res,
      ),
    ),
  );
  router.get('/appointments/availability', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await appointment(res).availability(res.locals.actor, req.query));
  });
  router.post('/appointments', async (req, res) => {
    const result = await deduplicated(
      db,
      res.locals.actor.sub,
      'appointment.create',
      req.headers['idempotency-key'],
      normalizeCreate(req.body, false),
      async tx => {
        const row = await appointment(res, tx).create(res.locals.actor, req.body);
        return { resourceId: row.id, response: { appointment: appointmentDto(row, res.locals.actor) } };
      },
    );
    sendMutation(res, result, 201);
  });
  const change = async (
    req: express.Request,
    res: express.Response,
    action: 'changeStatus' | 'reschedule' | 'cancel' | 'undoStatus',
  ) => {
    const result = await db.$transaction(async tx => {
      const row = await appointment(res, tx)[action](res.locals.actor, String(req.params.id), req.body ?? {});
      return { appointment: appointmentDto(row, res.locals.actor) };
    });
    sendMutation(res, result);
  };
  router.patch('/appointments/:id/status', async (req, res) => change(req, res, 'changeStatus'));
  router.patch('/appointments/:id/reschedule', async (req, res) => change(req, res, 'reschedule'));
  router.patch('/appointments/:id/cancel', async (req, res) => change(req, res, 'cancel'));
  router.get('/appointments/:id/status-history', async (req, res) =>
    res.json(await appointment(res).history(res.locals.actor, req.params.id)),
  );
  router.post('/appointments/:id/undo-status', async (req, res) => change(req, res, 'undoStatus'));
  router.post('/appointments/:id/reminder', async (req, res) => {
    await appointment(res).sendReminder(res.locals.actor, req.params.id);
    res.status(201).json({ message: 'Reminder request accepted.' });
  });
  router.get('/medical-records', async (req, res) =>
    authorizedRead(res, () => list(db, 'medicalRecords', res.locals.actor, res.locals.directory, req.query)),
  );
  router.post('/medical-records', async (req, res) => {
    const result = await deduplicated(
      db,
      res.locals.actor.sub,
      'medical-record.create',
      req.headers['idempotency-key'],
      normalizeCreate(req.body, true),
      async tx => {
        const row = await medical(res, tx).create(res.locals.actor, req.body);
        return { resourceId: row.id, response: { record: medicalRecordDto(row) } };
      },
    );
    sendMutation(res, result, 201);
  });
  router.patch('/medical-records/:id', async (req, res) =>
    res.json({
      record: medicalRecordDto(
        await medicalMutation(db, req.params.id, tx =>
          medical(res, tx).update(res.locals.actor, req.params.id, req.body ?? {}),
        ),
      ),
    }),
  );
  router.delete('/medical-records/:id', async (req, res) => {
    await medicalMutation(db, req.params.id, tx =>
      medical(res, tx).delete(res.locals.actor, req.params.id, req.query.expectedRevision),
    );
    res.status(204).end();
  });
  router.get('/medical-records/:id/history', async (req, res) =>
    res.json({ items: await medical(res).history(res.locals.actor, req.params.id) }),
  );
  router.get('/medical-records/images', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    await authorizedRead(res, () =>
      list(db, 'medicalImages', res.locals.actor, res.locals.directory, req.query, blobs),
    );
  });
  router.post('/medical-records/images', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ image: await medical(res).createImage(res.locals.actor, req.body) });
  });
  router.delete('/medical-records/images/:id', async (req, res) => {
    await medical(res).deleteImage(res.locals.actor, req.params.id);
    res.status(204).end();
  });
  router.post('/medical-records/images/:id/restore', async (req, res) => {
    await medical(res).restoreImage(res.locals.actor, req.params.id);
    res.status(204).end();
  });
  router.get('/dashboard/clinic', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...(await bootstrap(db, res.locals.actor, res.locals.directory)), asOf: new Date().toISOString() });
  });
  router.get('/dashboard/clinic/activity', async (req, res) => {
    // Express also matches trailing slashes/case variants; authorize the matched
    // operation itself, independently of the early exact-path rejection above.
    authorize(res.locals.actor, 'clinic-activity.read');
    const filter = parseActivityFilter(req.query);
    try {
      res.json(await activity.read(filter));
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError(503, 'Clinic activity is unavailable. Retry later.');
    }
  });
  app.use('/api', router);
  app.use((_req, res) => res.status(404).json({ error: 'Clinic route not found.' }));
  // A stale medical record edit returns the stored record, so the editor can keep its draft and show what changed.
  // A deferred read that fails before Core was asked still owes the caller Core's answer: settle first, and a refusal replaces the local error.
  const errors: ErrorRequestHandler = async (error, _req, res, _next) => {
    const directory = res.locals.directory;
    if (directory instanceof DeferredDirectory && !directory.settled)
      try {
        await directory.settle();
      } catch (refusal) {
        error = refusal;
      }
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof BusinessError) {
      if (error.status === 503) res.setHeader('Retry-After', '1');
      res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error instanceof StaleRevision ? { current: medicalRecordDto(error.current as MedicalRecordValue) } : {}),
      });
    } else if (error?.type === 'entity.parse.failed') res.status(400).json({ error: 'Invalid JSON.' });
    else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'Request too large.' });
    else if (error?.code === 'P2025') res.status(404).json({ error: 'Clinic resource not found.' });
    else if (isTransientFailure(error)) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Clinic unavailable. Retry the same request key.' });
    } else res.status(500).json(reportUnexpected('clinic', error, currentRequestId()));
  };
  app.use(errors);
  return app;
}
// Hash only fields the use case consumes, with its defaults/trim semantics.
function normalizeCreate(input: Record<string, unknown>, record: boolean) {
  if (record) return { petId: requiredText(input.petId, 'Pet', 200), ...medicalFields(input) };
  const names = record
    ? [
        'petId',
        'appointmentId',
        'doctorName',
        'visitDate',
        'title',
        'symptoms',
        'diagnosis',
        'treatment',
        'medications',
        'vaccineName',
        'followUpDate',
        'weightKg',
        'temperatureC',
        'heartRateBpm',
        'internalNote',
      ]
    : ['petId', 'type', 'date', 'time', 'serviceName', 'doctorId', 'clinicName', 'ownerNote'];
  const value: Record<string, unknown> = {};
  for (const k of names) {
    const v = input[k];
    value[k] =
      typeof v === 'string' ? (record || ['serviceName', 'ownerNote'].includes(k) ? v.trim() : v) : (v ?? null);
  }
  if (!record) {
    value.type = value.type || 'other';
    value.clinicName = value.clinicName || 'Nippon Pet Care';
    value.ownerNote = value.ownerNote || null;
    value.doctorId = value.doctorId || null;
  }
  if (
    !appointmentTypes.includes(value.type as (typeof appointmentTypes)[number]) ||
    typeof value.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  )
    throw new BusinessError(422, 'Invalid appointment service or time.');
  calendarDate(value.date, 'Appointment date');
  requiredText(value.serviceName, 'Service');
  // Calendar validation stays independent of current time: a committed retry
  // remains replayable tomorrow. The use case checks Vietnam today on creation.
  for (const k of ['doctorId', 'clinicName', 'ownerNote'])
    if (value[k] !== null && typeof value[k] !== 'string') throw new BusinessError(422, `Invalid ${k}.`);
  return value;
}
