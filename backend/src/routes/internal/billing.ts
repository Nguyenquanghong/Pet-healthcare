import type express from 'express';
import type { AppointmentInvoices } from '../../application/services/appointmentInvoices.js';
import { billingSafe } from '../appointmentBilling.js';
import { acceptsCredential } from '@nipopeto/runtime';

export function mountBillingEvidence(app: express.Express, billing: AppointmentInvoices, evidenceCredential: string) {
  app.get(
    '/internal/billing-operations/:operationId',
    billingSafe(async (req, res) => {
      if (!acceptsCredential(req.headers['x-service-token'], evidenceCredential)) {
        res.status(401).json({ error: 'Service authentication required.' });
        return;
      }
      const op = await billing.read(req.params.operationId as string);
      res.json({ operationId: op.id, state: op.state, appointmentId: op.appointmentId, invoiceId: op.invoiceId });
    }),
  );
}
