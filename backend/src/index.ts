import "dotenv/config";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { prisma } from "./lib/prisma.js";
import { requireAuth } from "./middleware/auth.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { authRouter } from "./routes/auth.js";
import { bootstrapRouter } from "./routes/bootstrap.js";
import { hotelBookingsRouter } from "./routes/hotelBookings.js";
import { invoicesRouter } from "./routes/invoices.js";
import { medicalRecordsRouter } from "./routes/medicalRecords.js";
import { notificationsRouter } from "./routes/notifications.js";
import { petsRouter } from "./routes/pets.js";
import { publicRouter } from "./routes/public.js";

const app = express();
const port = Number(process.env.PORT || 5000);
const origins = process.env.CORS_ORIGIN?.split(",").map((value) => value.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: origins?.length ? origins : false, credentials: true }));
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", service: "NIPOPETO API", version: "2.0.0", database: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", service: "NIPOPETO API", version: "2.0.0", database: "disconnected" });
  }
});

app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false }), authRouter);
app.use("/api/public", publicRouter);
app.use("/api/bootstrap", requireAuth, bootstrapRouter);
app.use("/api/pets", requireAuth, petsRouter);
app.use("/api/appointments", requireAuth, appointmentsRouter);
app.use("/api/medical-records", requireAuth, medicalRecordsRouter);
app.use("/api/hotel-bookings", requireAuth, hotelBookingsRouter);
app.use("/api/notifications", requireAuth, notificationsRouter);
app.use("/api/invoices", requireAuth, invoicesRouter);

app.use((req, res) => res.status(404).json({ error: `Route ${req.originalUrl} was not found.` }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

const server = app.listen(port, () => console.log(`NIPOPETO API listening on http://localhost:${port}`));

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
