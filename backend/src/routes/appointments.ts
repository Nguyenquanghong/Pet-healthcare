/** @deprecated Legacy monolith route (createApp only); split mode proxies this prefix to Clinic. */
import { Router } from "express";
import { AppointmentService } from "../application/services/appointments.js";
import { appointmentDto } from "../lib/serialize.js";
import { failure } from "./failure.js";

export function createAppointmentsRouter(service: AppointmentService) {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const appointment = await service.create(req.auth!, req.body);
      res.status(201).json({ appointment: appointmentDto(appointment, req.auth!) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/status", async (req, res) => {
    try {
      const appointment = await service.changeStatus(req.auth!, req.params.id, req.body ?? {});
      res.json({ appointment: appointmentDto(appointment, req.auth!) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/reschedule", async (req, res) => {
    try {
      const appointment = await service.reschedule(req.auth!, req.params.id, req.body ?? {});
      res.json({ appointment: appointmentDto(appointment, req.auth!) });
    } catch (error) { failure(res, error); }
  });

  router.get("/:id/status-history", async (req, res) => {
    try { res.json(await service.history(req.auth!, req.params.id)); }
    catch (error) { failure(res, error); }
  });
  router.post("/:id/undo-status", async (req, res) => {
    try { res.json({ appointment: appointmentDto(await service.undoStatus(req.auth!, req.params.id, req.body ?? {}), req.auth!) }); }
    catch (error) { failure(res, error); }
  });

  router.patch("/:id/cancel", async (req, res) => {
    try {
      const appointment = await service.cancel(req.auth!, req.params.id, req.body ?? {});
      res.json({ appointment: appointmentDto(appointment, req.auth!) });
    } catch (error) { failure(res, error); }
  });

  router.post("/:id/reminder", async (req, res) => {
    try {
      await service.sendReminder(req.auth!, req.params.id);
      res.status(201).json({ message: "Reminder request accepted." });
    } catch (error) { failure(res, error); }
  });

  return router;
}
