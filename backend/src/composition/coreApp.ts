import express from 'express';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { coreConfigFromEnv, coreSettings, type CoreConfig } from './config.js';
import { applySecurity } from './http.js';
import { mountDirectory, mountNotificationAuthorization } from './internalRoutes.js';
import { mountBillingEvidence } from '../routes/internal/billing.js';
import { mountAppointmentBilling } from '../routes/appointmentBilling.js';
import { mountDashboards } from '../routes/dashboard.js';
import { AppointmentInvoiceBilling } from './appointmentBilling.js';
import { ClinicBillingRemote } from '../infrastructure/http/clinicBillingRemote.js';
import { coreRuntime } from './runtime.js';
import { createCoreDomains } from './coreDomains.js';
import { requestFault } from '@nipopeto/runtime';
import { serviceProxy } from '../gateway/serviceProxy.js';
import { createAuthRouter } from '../routes/auth.js';
import { AuthService } from '../application/services/auth.js';
import { OwnerActivationService } from '../application/services/ownerActivation.js';
import { PrismaUserRepository } from '../infrastructure/persistence/userRepository.js';
import { PrismaOwnerActivationRepository } from '../infrastructure/persistence/ownerActivationRepository.js';
import { activationTokenAdapter } from '../infrastructure/security/activationToken.js';
import { passwordAdapter, tokenAdapter } from '../infrastructure/security/authAdapters.js';
import { currentAccount } from '../middleware/currentAccount.js';

// Paths the gateway forwards to Clinic; the proxy checks them again after resolving the URL.
const clinicPrefixes = ['/api/appointments', '/api/medical-records', '/api/dashboard/clinic'] as const;

// Keep the user's app.ts intact. This composition owns the split service route
// and the private Core authorization endpoint before mounting existing domains.
export function createCoreApp(db: PrismaClient, config: CoreConfig = coreConfigFromEnv()) {
  const { clinic, notification } = coreSettings(config);
  const app = express();
  applySecurity(app, { exposedHeaders: ['X-Service-Degraded', 'Retry-After'] });
  const runtime = coreRuntime(db);
  runtime?.install(app);
  app.use('/api', currentAccount(db));
  if (runtime)
    app.use(
      '/api/auth',
      createAuthRouter(
        new AuthService({ users: new PrismaUserRepository(db), passwords: passwordAdapter, tokens: tokenAdapter }),
        new OwnerActivationService(new PrismaOwnerActivationRepository(db), activationTokenAdapter, passwordAdapter),
      ),
    );
  mountDirectory(app, db, config.directoryToken ?? config.clinicToken);
  mountDashboards(app, db, Boolean(clinic));
  if (clinic) {
    app.use(
      [...clinicPrefixes],
      express.json({ limit: '8mb' }),
      serviceProxy({
        name: 'clinic',
        origin: clinic,
        prefixes: clinicPrefixes,
        forwardRequestHeaders: ['authorization', 'idempotency-key'],
        forwardResponseHeaders: ['x-service-instance', 'x-service-degraded', 'retry-after', 'cache-control'],
        timeoutMs: 6000,
        unavailableMessage: 'Clinic service unavailable. Retry the same request key.',
        notFoundMessage: 'Clinic route not found.',
      }),
    );
    const billing = new AppointmentInvoiceBilling(db, new ClinicBillingRemote(clinic, config.clinicToken!));
    mountBillingEvidence(app, billing, config.evidenceToken ?? config.clinicToken!);
    mountAppointmentBilling(app, billing);
  }
  mountNotificationAuthorization(app, db, config.notificationToken);

  const notificationProxy = notification
    ? serviceProxy({
        name: 'notification',
        origin: notification,
        prefixes: ['/api/notifications'],
        forwardRequestHeaders: ['authorization', 'idempotency-key'],
        forwardResponseHeaders: ['retry-after', 'x-service-degraded', 'x-service-instance'],
        timeoutMs: 4000,
        unavailableMessage: 'Notification service unavailable. Retry the same request key.',
        notFoundMessage: 'Notification route not found.',
      })
    : null;
  app.use('/api/notifications', express.json({ limit: '96kb' }), (req, res, next) => {
    if (!notificationProxy) {
      res.status(503).json({ error: 'Notification service is not configured.' });
      return;
    }
    return notificationProxy(req, res, next);
  });
  app.use(runtime ? createCoreDomains(db) : createApp(db));
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
