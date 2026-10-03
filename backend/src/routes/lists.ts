import { Router } from "express";
import type { ListsService } from "../application/services/lists.js";
import { listResultDto } from "../lib/listSerialize.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

// Mounted before the write routers; only these GET handlers run authentication here.
export function createListsRouter(service: ListsService) {
  const router = Router();
  router.get("/owners", requireAuth, requireRole("admin", "staff", "doctor"), async (req, res) => res.json(listResultDto("owners", await service.load("owners", req.auth!, req.query), false)));
  router.get("/pets", requireAuth, async (req, res) => res.json(listResultDto("pets", await service.load("pets", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/appointments", requireAuth, async (req, res) => res.json(listResultDto("appointments", await service.load("appointments", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/appointments/calendar", requireAuth, async (req, res) => res.json(await service.calendar(req.auth!, req.query.month, req.query.category)));
  router.get("/hotel-bookings", requireAuth, async (req, res) => res.json(listResultDto("hotelBookings", await service.load("hotelBookings", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/medical-records", requireAuth, async (req, res) => res.json(listResultDto("medicalRecords", await service.load("medicalRecords", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/medical-records/images", requireAuth, async (req, res) => res.json(listResultDto("medicalImages", await service.load("medicalImages", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/hotel-care-notes", requireAuth, async (req, res) => res.json(listResultDto("dailyCareNotes", await service.load("dailyCareNotes", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/notifications", requireAuth, async (req, res) => res.json(listResultDto("notifications", await service.load("notifications", req.auth!, req.query), req.auth!.role === "owner")));
  router.get("/invoices/summary", requireAuth, async (req, res) => res.json(await service.billingFigures(req.auth!, req.query.month)));
  router.get("/invoices", requireAuth, async (req, res) => res.json(listResultDto("invoices", await service.load("invoices", req.auth!, req.query), req.auth!.role === "owner")));
  return router;
}
