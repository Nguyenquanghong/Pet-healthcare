import cors from "cors";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import openapi from "../openapi.json" with { type: "json" };
import { AppointmentService } from "./application/services/appointments.js";
import { MedicalRecordsService } from "./application/services/medicalRecords.js";
import { HotelBookingsService } from "./application/services/hotelBookings.js";
import { NotificationsService } from "./application/services/notifications.js";
import { AuthService } from "./application/services/auth.js";
import { PetsService } from "./application/services/pets.js";
import { PublicRescueService } from "./application/services/publicRescue.js";
import { InvoicesService } from "./application/services/invoices.js";
import { BookingLifecycleService } from "./application/services/bookingLifecycle.js";
import { PrismaBookingLifecycleStore } from "./infrastructure/persistence/bookingLifecycleRepository.js";
import { VietQrGenerator } from "./infrastructure/payments/vietqr.js";
import { PaymentsService } from "./application/services/payments.js";
import { PrismaPaymentRepository } from "./infrastructure/persistence/paymentRepository.js";
import { VnpaySandboxGateway } from "./infrastructure/security/vnpay.js";
import { bankTransferConfig } from "./infrastructure/config/bankTransfer.js";
import { createPaymentsRouter } from "./routes/payments.js";
import { BootstrapService } from "./application/services/bootstrap.js";
import { createAppointmentDependencies } from "./infrastructure/persistence/appointmentRepository.js";
import { createMedicalDependencies } from "./infrastructure/persistence/medicalRepository.js";
import { createHotelDependencies } from "./infrastructure/persistence/hotelRepository.js";
import { PrismaNotificationRepository } from "./infrastructure/persistence/notificationRepository.js";
import { PrismaUserRepository } from "./infrastructure/persistence/userRepository.js";
import { PrismaPetRepository } from "./infrastructure/persistence/petRepository.js";
import { createPublicRescueDependencies } from "./infrastructure/persistence/publicRescueRepository.js";
import { PrismaInvoiceRepository } from "./infrastructure/persistence/invoiceRepository.js";
import { PrismaBootstrapRepository } from "./infrastructure/persistence/bootstrapRepository.js";
import { databaseHealthCheck } from "./infrastructure/persistence/healthRepository.js";
import { passwordAdapter, tokenAdapter } from "./infrastructure/security/authAdapters.js";
import { qrTokenAdapter } from "./infrastructure/security/qrToken.js";
import { requireAuth } from "./middleware/auth.js";
import { createAppointmentsRouter } from "./routes/appointments.js";
import { createAuthRouter } from "./routes/auth.js";
import { createBootstrapRouter } from "./routes/bootstrap.js";
import { createHotelBookingsRouter } from "./routes/hotelBookings.js";
import { createInvoicesRouter } from "./routes/invoices.js";
import { createMedicalRecordsRouter } from "./routes/medicalRecords.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createPetsRouter } from "./routes/pets.js";
import { createPublicRouter } from "./routes/public.js";

export function createApp(client: PrismaClient) {
  const app = express();
  const bankTransfer = bankTransferConfig(process.env);
  const checkDatabase = databaseHealthCheck(client);
  const origins = process.env.CORS_ORIGIN?.split(",").map((value) => value.trim()).filter(Boolean);

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: origins?.length ? origins : false, credentials: true }));
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/openapi.json", (_req, res) => res.json(openapi));
  app.use("/api/docs", (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
    next();
  }, swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "NIPOPETO API docs" }));

  app.get("/api/health", async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: "ok", service: "NIPOPETO API", version: "2.0.0", database: "connected" });
    } catch {
      res.status(503).json({ status: "degraded", service: "NIPOPETO API", version: "2.0.0", database: "disconnected" });
    }
  });

  app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests, please try again later." } }), createAuthRouter(new AuthService({ users: new PrismaUserRepository(client), passwords: passwordAdapter, tokens: tokenAdapter })));
  app.use("/api/public", createPublicRouter(new PublicRescueService(createPublicRescueDependencies(client))));
  app.use("/api/bootstrap", requireAuth, createBootstrapRouter(new BootstrapService(new PrismaBootstrapRepository(client))));
  app.use("/api/pets", requireAuth, createPetsRouter(new PetsService(new PrismaPetRepository(client), qrTokenAdapter)));
  const lifecycle = new BookingLifecycleService(new PrismaBookingLifecycleStore(client));
  app.use("/api/appointments", requireAuth, createAppointmentsRouter(new AppointmentService(createAppointmentDependencies(client), lifecycle)));
  app.use("/api/medical-records", requireAuth, createMedicalRecordsRouter(new MedicalRecordsService(createMedicalDependencies(client))));
  app.use("/api/hotel-bookings", requireAuth, createHotelBookingsRouter(new HotelBookingsService(createHotelDependencies(client), lifecycle)));
  app.use("/api/notifications", requireAuth, createNotificationsRouter(new NotificationsService(new PrismaNotificationRepository(client))));
  app.use("/api/invoices", requireAuth, createInvoicesRouter(new InvoicesService(new PrismaInvoiceRepository(client), bankTransfer, new VietQrGenerator())));
  app.use("/api/payments", createPaymentsRouter(new PaymentsService(new PrismaPaymentRepository(client), new VnpaySandboxGateway({
    tmnCode: process.env.VNPAY_TMN_CODE || "", hashSecret: process.env.VNPAY_HASH_SECRET || "",
    returnUrl: process.env.VNPAY_RETURN_URL || "",
    active: process.env.VNPAY_ENABLED === "true",
  }), bankTransfer)));

  app.use((req, res) => res.status(404).json({ error: `Route ${req.originalUrl} was not found.` }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const bodyError = error as { type?: string } | null;
    if (bodyError?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    if (bodyError?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
