import { Router, type Response } from "express";
import { HotelBookingsService } from "../application/services/hotelBookings.js";
import { BusinessError } from "../domain/error.js";
import { careNoteDto, hotelBookingDto } from "../lib/serialize.js";

export function createHotelBookingsRouter(service: HotelBookingsService) {
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
    res.json((await service.list(req.auth!, ownerId)).map(hotelBookingDto));
  });

  router.post("/", async (req, res) => {
    try {
      const booking = await service.create(req.auth!, req.body);
      res.status(201).json({ booking: hotelBookingDto(booking) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/status", async (req, res) => {
    try {
      const booking = await service.changeStatus(req.auth!, req.params.id, req.body);
      res.json({ booking: hotelBookingDto(booking) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/cancel", async (req, res) => {
    try {
      const booking = await service.cancel(req.auth!, req.params.id, req.body.ownerNote);
      res.json({ booking: hotelBookingDto(booking) });
    } catch (error) { failure(res, error); }
  });

  router.post("/:id/care-notes", async (req, res) => {
    try {
      const careNote = await service.addCareNote(req.auth!, req.params.id, req.body);
      res.status(201).json({ careNote: careNoteDto(careNote) });
    } catch (error) { failure(res, error); }
  });

  return router;
}
