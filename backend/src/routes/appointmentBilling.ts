import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { BusinessError } from '../domain/error.js';
import type { AppointmentInvoices } from '../application/services/appointmentInvoices.js';
import { currentRequestId, isTransientFailure, reportUnexpected } from '@nipopeto/runtime';
import { invoiceDto } from './dto/serialize.js';

type BillingResult = Awaited<ReturnType<AppointmentInvoices['result']>>;

const wireResult = (result: BillingResult) =>
  result.status === 'succeeded' ? { ...result, invoice: invoiceDto(result.invoice) } : result;

export const billingSafe =
  (work: (req: express.Request, res: express.Response) => Promise<void>) =>
  async (req: express.Request, res: express.Response) => {
    try {
      await work(req, res);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof BusinessError) res.status(e.status).json({ error: e.message });
      else if (isTransientFailure(e)) {
        res.setHeader('Retry-After', '1');
        res.status(503).json({ error: 'Billing temporarily unavailable. Retry the same request key.' });
      } else res.status(500).json(reportUnexpected('core', e, currentRequestId()));
    }
  };

export function mountAppointmentBilling(app: express.Express, billing: AppointmentInvoices) {
  app.get(
    '/api/operations/:id',
    requireAuth,
    billingSafe(async (req, res) => {
      await billing.actor(req.auth!);
      const op = await billing.read(req.params.id as string);
      if (op.actorId !== req.auth!.sub || op.actorRole !== req.auth!.role)
        throw new BusinessError(404, 'Operation not found.');
      res.setHeader('Cache-Control', 'no-store');
      res.json(wireResult(await billing.result(op)));
    }),
  );
  for (const [path, self] of [
    ['/api/invoices', false],
    ['/api/invoices/checkout', true],
  ] as const) {
    app.post(path, express.json({ limit: '96kb' }), (req, res, next) => {
      if (req.body?.type !== 'appointment' && !req.body?.appointmentId) {
        next();
        return;
      }
      requireAuth(
        req,
        res,
        () =>
          void billingSafe(async (req, res) => {
            const op = await billing.begin(req.auth!, req.body, req.headers['idempotency-key'], self);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const running = billing.resume(op.id);
            // A request deadline ends waiting, not the durable operation. The same
            // row/lock still determines commit vs abort if work finishes afterward.
            let outcome;
            try {
              outcome = await Promise.race([
                running,
                new Promise<typeof op>(resolve => {
                  timer = setTimeout(() => resolve(op), 4500);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
            const result = wireResult(await billing.result(outcome));
            if (process.env.PHASE2_RUNTIME_REQUIRED === '1')
              process.stdout.write(
                JSON.stringify({
                  service: 'core',
                  requestId: currentRequestId() ?? null,
                  operationId: op.id,
                  status: result.status,
                }) + '\n',
              );
            if (res.headersSent) return;
            res.setHeader('Cache-Control', 'no-store');
            if (result.status === 'pending') {
              res.setHeader('Location', '/api/operations/' + op.id);
              res.setHeader('Retry-After', '1');
              res.status(202).json(result);
            } else if (result.status === 'failed')
              res.status(result.errorStatus!).json({ error: result.error, operationId: op.id, status: 'failed' });
            else res.status(self ? 200 : 201).json({ invoice: result.invoice });
          })(req, res),
      );
    });
  }
}
