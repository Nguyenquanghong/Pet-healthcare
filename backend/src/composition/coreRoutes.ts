import express from 'express';
import type { Express, RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { PrismaClient } from '@prisma/client';
import openapi from '../../openapi.json' with { type: 'json' };
import { AppointmentService } from '../legacy/application/services/appointments.js';
import { MedicalRecordsService } from '../legacy/application/services/medicalRecords.js';
import { HotelBookingsService } from '../application/services/hotelBookings.js';
import { NotificationsService } from '../legacy/application/services/notifications.js';
import { AuthService } from '../application/services/auth.js';
import { PetsService } from '../application/services/pets.js';
import { ListsService } from '../application/services/lists.js';
import { PrismaListsRepository } from '../infrastructure/persistence/listsRepository.js';
import { createListsRouter } from '../routes/lists.js';
import { OwnersService } from '../application/services/owners.js';
import { OwnerActivationService } from '../application/services/ownerActivation.js';
import { PrismaOwnerActivationRepository } from '../infrastructure/persistence/ownerActivationRepository.js';
import { activationTokenAdapter } from '../infrastructure/security/activationToken.js';
import { PublicRescueService } from '../application/services/publicRescue.js';
import { InvoicesService } from '../application/services/invoices.js';
import { BookingLifecycleService } from '../application/services/bookingLifecycle.js';
import { PrismaBookingLifecycleStore } from '../infrastructure/persistence/bookingLifecycleRepository.js';
import { VietQrGenerator } from '../infrastructure/payments/vietqr.js';
import { PaymentsService } from '../application/services/payments.js';
import { PrismaPaymentRepository } from '../infrastructure/persistence/paymentRepository.js';
import { VnpaySandboxGateway } from '../infrastructure/security/vnpay.js';
import { bankTransferConfig } from '../infrastructure/config/bankTransfer.js';
import { createPaymentsRouter } from '../routes/payments.js';
import { BootstrapService } from '../application/services/bootstrap.js';
import { createAppointmentDependencies } from '../legacy/infrastructure/persistence/appointmentRepository.js';
import { createMedicalDependencies } from '../legacy/infrastructure/persistence/medicalRepository.js';
import { createHotelDependencies } from '../infrastructure/persistence/hotelRepository.js';
import { PrismaNotificationRepository } from '../legacy/infrastructure/persistence/notificationRepository.js';
import { PrismaUserRepository } from '../infrastructure/persistence/userRepository.js';
import { PrismaPetRepository } from '../infrastructure/persistence/petRepository.js';
import { PrismaOwnerRepository } from '../infrastructure/persistence/ownerRepository.js';
import { createPublicRescueDependencies } from '../infrastructure/persistence/publicRescueRepository.js';
import { PrismaInvoiceRepository } from '../infrastructure/persistence/invoiceRepository.js';
import { PrismaBootstrapRepository } from '../infrastructure/persistence/bootstrapRepository.js';
import { databaseHealthCheck } from '../infrastructure/persistence/healthRepository.js';
import { passwordAdapter, tokenAdapter } from '../infrastructure/security/authAdapters.js';
import { qrTokenAdapter } from '../infrastructure/security/qrToken.js';
import { ClinicBillingRemote } from '../infrastructure/http/clinicBillingRemote.js';
import { serviceVersion } from '../lib/version.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { serviceProxy } from '../gateway/serviceProxy.js';
import { createAppointmentsRouter } from '../legacy/routes/appointments.js';
import { createAuthRouter } from '../routes/auth.js';
import { createBootstrapRouter } from '../legacy/routes/bootstrap.js';
import { createHotelBookingsRouter } from '../routes/hotelBookings.js';
import { createHotelCapacityRouter } from '../routes/hotelCapacity.js';
import { HotelCapacityService } from '../application/services/hotelCapacity.js';
import { PrismaHotelCapacityRepository } from '../infrastructure/persistence/hotelCapacityRepository.js';
import { createInvoicesRouter } from '../routes/invoices.js';
import { createMedicalRecordsRouter } from '../legacy/routes/medicalRecords.js';
import { createNotificationsRouter } from '../legacy/routes/notifications.js';
import { createPetsRouter } from '../routes/pets.js';
import { createOwnersRouter } from '../routes/owners.js';
import { createPublicRouter } from '../routes/public.js';
import { mountAppointmentBilling } from '../routes/appointmentBilling.js';
import { mountBillingEvidence } from '../routes/internal/billing.js';
import { mountDashboards } from '../routes/dashboard.js';
import { AppointmentInvoiceBilling } from './appointmentBilling.js';
import type { CoreSettings } from './config.js';
import { mountDirectory, mountNotificationAuthorization } from './internalRoutes.js';

// Paths the gateway forwards to Clinic; the proxy checks them again after resolving the URL.
const clinicPrefixes = ['/api/appointments', '/api/medical-records', '/api/dashboard/clinic'] as const;

export type CoreRouteOptions = {
  // The appointment and medical-record routers. Every composition still mounts them; the split one puts the Clinic proxy in front.
  clinical: boolean;
  // Only the legacy entrypoint: /api/auth with its limiter, /api/bootstrap and the in-process /api/notifications.
  monolith?: { authLimiter: RequestHandler };
};

// The OpenAPI document, its docs page and the health check: no authentication and no domain.
function mountServiceInfo(app: Express, client: PrismaClient) {
  const checkDatabase = databaseHealthCheck(client);
  app.get('/api/openapi.json', (_req, res) => res.json(openapi));
  app.use(
    '/api/docs',
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(openapi, { customSiteTitle: 'NIPOPETO API docs' }),
  );

  app.get('/api/health', async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: 'ok', service: 'NIPOPETO API', version: serviceVersion, database: 'connected' });
    } catch {
      res
        .status(503)
        .json({ status: 'degraded', service: 'NIPOPETO API', version: serviceVersion, database: 'disconnected' });
    }
  });
}

// The routes every Core composition shares. The order is part of the contract: the first matching mount answers.
export function mountCoreRoutes(app: Express, client: PrismaClient, { clinical, monolith }: CoreRouteOptions) {
  // Read when the routes are mounted, so a restart picks up a changed environment.
  const bankTransfer = bankTransferConfig(process.env);
  const activation = new OwnerActivationService(
    new PrismaOwnerActivationRepository(client),
    activationTokenAdapter,
    passwordAdapter,
  );
  const lifecycle = new BookingLifecycleService(new PrismaBookingLifecycleStore(client));

  mountServiceInfo(app, client);
  if (monolith)
    app.use(
      '/api/auth',
      monolith.authLimiter,
      createAuthRouter(
        new AuthService({ users: new PrismaUserRepository(client), passwords: passwordAdapter, tokens: tokenAdapter }),
        activation,
      ),
    );
  app.use('/api/public', createPublicRouter(new PublicRescueService(createPublicRescueDependencies(client))));
  app.use('/api', createListsRouter(new ListsService(new PrismaListsRepository(client))));
  if (monolith)
    app.use(
      '/api/bootstrap',
      requireAuth,
      createBootstrapRouter(new BootstrapService(new PrismaBootstrapRepository(client))),
    );
  app.use('/api/pets', requireAuth, createPetsRouter(new PetsService(new PrismaPetRepository(client), qrTokenAdapter)));
  app.use(
    '/api/owners',
    requireAuth,
    requirePermission('owner.manage'),
    createOwnersRouter(new OwnersService(new PrismaOwnerRepository(client)), activation),
  );
  if (clinical) {
    app.use(
      '/api/appointments',
      requireAuth,
      createAppointmentsRouter(new AppointmentService(createAppointmentDependencies(client), lifecycle)),
    );
    app.use(
      '/api/medical-records',
      requireAuth,
      createMedicalRecordsRouter(new MedicalRecordsService(createMedicalDependencies(client))),
    );
  }
  app.use(
    '/api/hotel-bookings',
    requireAuth,
    createHotelBookingsRouter(new HotelBookingsService(createHotelDependencies(client), lifecycle)),
  );
  app.use(
    '/api/hotel-capacity',
    requireAuth,
    createHotelCapacityRouter(new HotelCapacityService(new PrismaHotelCapacityRepository(client))),
  );
  if (monolith)
    app.use(
      '/api/notifications',
      requireAuth,
      createNotificationsRouter(new NotificationsService(new PrismaNotificationRepository(client))),
    );
  app.use(
    '/api/invoices',
    requireAuth,
    createInvoicesRouter(new InvoicesService(new PrismaInvoiceRepository(client), bankTransfer, new VietQrGenerator())),
  );
  app.use(
    '/api/payments',
    createPaymentsRouter(
      new PaymentsService(
        new PrismaPaymentRepository(client),
        new VnpaySandboxGateway({
          tmnCode: process.env.VNPAY_TMN_CODE || '',
          hashSecret: process.env.VNPAY_HASH_SECRET || '',
          returnUrl: process.env.VNPAY_RETURN_URL || '',
          active: process.env.VNPAY_ENABLED === 'true',
        }),
        bankTransfer,
      ),
    ),
  );
}

// What only the gateway composition mounts, ahead of the shared routes: the shared auth policy, the private Core endpoints,
// the dashboards, and the Clinic and Notification services when they are split off.
export function mountSplitRoutes(app: Express, db: PrismaClient, settings: CoreSettings, runtimeActive: boolean) {
  const { config, clinic, notification } = settings;
  if (runtimeActive)
    app.use(
      '/api/auth',
      createAuthRouter(
        new AuthService({ users: new PrismaUserRepository(db), passwords: passwordAdapter, tokens: tokenAdapter }),
        new OwnerActivationService(new PrismaOwnerActivationRepository(db), activationTokenAdapter, passwordAdapter),
      ),
    );
  mountDirectory(app, db, config.directoryToken ?? config.clinicToken);
  mountDashboards(
    app,
    {
      core: new BootstrapService(new PrismaBootstrapRepository(db, true, true)),
      clinic: new BootstrapService(new PrismaBootstrapRepository(db, false, true)),
      account: id => db.user.findUnique({ where: { id }, select: { role: true } }),
    },
    Boolean(clinic),
  );
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
}
