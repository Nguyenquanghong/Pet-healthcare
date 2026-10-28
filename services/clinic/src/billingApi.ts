import express from 'express';
import type { PrismaClient } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import type { CoreDirectory } from './directory.js';
import { AppointmentBilling } from './runtimeBilling.js';

export function mountBilling(
  app: express.Express,
  db: PrismaClient,
  verify: ((token: string) => Actor) | undefined,
  source: CoreDirectory | undefined,
) {
  const router = express.Router(),
    billing = new AppointmentBilling(db);
  router.use((req, res, next) => {
    if (!/^\/billing-(sources|reservations)(\/|$)/.test(req.path)) {
      next('router');
      return;
    }
    if (!source || !source.acceptsService(req.headers['x-service-token'])) {
      res.status(401).json({ error: 'Service authentication required.' });
      return;
    }
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  const actor = (req: express.Request) => {
    const h = req.headers.authorization;
    if (!verify || !h?.startsWith('Bearer ') || h.length > 8192)
      throw new BusinessError(401, 'Actor authentication required.');
    try {
      return verify(h.slice(7));
    } catch {
      throw new BusinessError(401, 'Invalid actor context.');
    }
  };
  const id = (v: string) => {
    if (!v || v.length > 128) throw new BusinessError(422, 'Invalid billing ID.');
    return v;
  };
  router.get('/billing-sources/:id', async (req, res) =>
    res.json({ snapshot: await billing.source(id(req.params.id), actor(req)) }),
  );
  router.put('/billing-reservations/:operationId', async (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.appointmentId !== 'string' ||
      Object.keys(body).some(k => !['appointmentId', 'expectedRevision'].includes(k))
    )
      throw new BusinessError(422, 'Invalid reservation request.');
    const snapshot = await billing.prepare(
      id(req.params.operationId),
      id(body.appointmentId),
      body.expectedRevision,
      actor(req),
    );
    res.json({ snapshot });
  });
  router.get('/billing-reservations/:operationId', async (req, res) => {
    const r = await db.appointmentReservation.findUnique({ where: { operationId: id(req.params.operationId) } });
    if (!r) throw new BusinessError(404, 'Reservation not found.');
    res.json({
      operationId: r.operationId,
      appointmentId: r.appointmentId,
      state: r.state,
      invoiceId: r.invoiceId,
      snapshot: r.snapshot,
    });
  });
  for (const action of ['commit', 'release'] as const)
    router.post(`/billing-reservations/:operationId/${action}`, async (req, res) => {
      if (
        req.body !== undefined &&
        (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)
      )
        throw new BusinessError(422, 'Terminal evidence comes from Core.');
      const operationId = id(req.params.operationId),
        evidence = await source!.operationEvidence(operationId);
      if (evidence.state !== (action === 'commit' ? 'COMMITTED' : 'ABORTED'))
        throw new BusinessError(409, 'Core operation has not reached the required terminal state.');
      await billing.reconcile(operationId, evidence);
      res.json({ operationId, state: action === 'commit' ? 'INVOICED' : 'RELEASED' });
    });
  app.use('/internal', router);
}
