import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { petsRouter } from "./routes/pets";
import { appointmentsRouter } from "./routes/appointments";
import { medicalRecordsRouter } from "./routes/medicalRecords";
import { hotelBookingsRouter } from "./routes/hotelBookings";
import { notificationsRouter } from "./routes/notifications";
import { invoicesRouter } from "./routes/invoices";
import { db } from "./db";

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "NIPONETO Backend REST API",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    stats: {
      users: db.get().users.length,
      pets: db.get().pets.length,
      appointments: db.get().appointments.length,
      medicalRecords: db.get().medicalRecords.length,
      hotelBookings: db.get().hotelBookings.length,
    },
  });
});

// Register API Domain Routers
app.use("/api/auth", authRouter);
app.use("/api/pets", petsRouter);
app.use("/api/appointments", appointmentsRouter);
app.use("/api/medical-records", medicalRecordsRouter);
app.use("/api/hotel-bookings", hotelBookingsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/invoices", invoicesRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.originalUrl} không tồn tại trên server` });
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled Server Error:", err);
  res.status(500).json({ error: "Lỗi máy chủ nội bộ", details: err.message });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 NIPONETO REST API Server đang chạy tại:`);
  console.log(`👉 http://localhost:${PORT}/api/health`);
  console.log(`====================================================`);
});
