import { Router } from "express";
import { BootstrapService } from "../application/services/bootstrap.js";
import { appointmentDto, careNoteDto, hotelBookingDto, medicalRecordDto, ownerDto, petDto } from "../lib/serialize.js";

export function createBootstrapRouter(service: BootstrapService) {
  const router = Router();
  router.get("/", async (req, res) => {
    const data = await service.load(req.auth!);
    res.json({
      currentOwnerId: data.currentOwnerId,
      owners: data.owners.map(ownerDto),
      pets: data.pets.map(petDto),
      appointments: data.appointments.map(appointmentDto),
      medicalRecords: data.medicalRecords.map(medicalRecordDto),
      medicalImages: data.medicalImages,
      hotelBookings: data.hotelBookings.map(hotelBookingDto),
      dailyCareNotes: data.dailyCareNotes.map(careNoteDto),
      notifications: data.notifications,
    });
  });
  return router;
}
