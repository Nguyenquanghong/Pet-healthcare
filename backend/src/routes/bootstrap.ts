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
      appointments: data.appointments.map(item => appointmentDto(item, req.auth!.role === "owner")),
      medicalRecords: data.medicalRecords.map(item => medicalRecordDto(item, req.auth!.role === "owner")),
      medicalImages: data.medicalImages,
      hotelBookings: data.hotelBookings.map(item => hotelBookingDto(item, req.auth!.role === "owner")),
      dailyCareNotes: data.dailyCareNotes.map(careNoteDto),
      notifications: data.notifications,
    });
  });
  return router;
}
