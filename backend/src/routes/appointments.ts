import { Router, type Response } from "express";
import { AppointmentService } from "../application/services/appointments.js";
import { BusinessError } from "../domain/error.js";
import { appointmentDto } from "../lib/serialize.js";

export function createAppointmentsRouter(service: AppointmentService) {
  const router = Router();

  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  router.get("/", async (req, res) => {
    const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
    res.json((await service.list(req.auth!, ownerId)).map(appointmentDto));
  });

  router.post("/", async (req, res) => {
    try {
      const appointment = await service.create(req.auth!, req.body);
      res.status(201).json({ appointment: appointmentDto(appointment) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/status", async (req, res) => {
    try {
      const appointment = await service.changeStatus(req.auth!, req.params.id, req.body);
      res.json({ appointment: appointmentDto(appointment) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/reschedule", async (req, res) => {
    try {
      const appointment = await service.reschedule(req.auth!, req.params.id, req.body);
      res.json({ appointment: appointmentDto(appointment) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/cancel", async (req, res) => {
    try {
      const appointment = await service.cancel(req.auth!, req.params.id, req.body);
      res.json({ appointment: appointmentDto(appointment) });
    } catch (error) { failure(res, error); }
  });

  router.post("/:id/reminder", async (req, res) => {
    try {
      await service.sendReminder(req.auth!, req.params.id);
      res.status(201).json({ message: "Reminder sent." });
    } catch (error) { failure(res, error); }
  });

  return router;
}
