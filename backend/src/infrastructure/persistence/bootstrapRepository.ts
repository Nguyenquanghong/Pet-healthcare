import type { PrismaClient } from "@prisma/client";
import type { BootstrapRepository } from "../../application/ports/bootstrap.js";

export class PrismaBootstrapRepository implements BootstrapRepository {
  constructor(private readonly client: PrismaClient) {}

  async load(isAdmin: boolean, ownerId?: string) {
    const [owners, pets, appointments, medicalRecords, medicalImages, hotelBookings, dailyCareNotes, notifications] = await Promise.all([
      this.client.user.findMany({ where: isAdmin ? { role: "owner" } : { id: ownerId }, include: { pets: { select: { id: true } } }, orderBy: { fullName: "asc" } }),
      this.client.pet.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: { createdAt: "desc" } }),
      this.client.appointment.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }] }),
      this.client.medicalRecord.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: { visitDate: "desc" } }),
      this.client.medicalImage.findMany({ where: ownerId ? { pet: { ownerId } } : undefined, orderBy: { createdAt: "desc" } }),
      this.client.hotelBooking.findMany({ where: ownerId ? { ownerId } : undefined, include: { dailyCareNotes: { select: { id: true } } }, orderBy: { createdAt: "desc" } }),
      this.client.dailyCareNote.findMany({ where: ownerId ? { booking: { ownerId }, visibleToOwner: true } : undefined, orderBy: { createdAt: "desc" } }),
      this.client.notification.findMany({ where: isAdmin ? { recipientRole: "admin" } : { recipientOwnerId: ownerId }, orderBy: { createdAt: "desc" } }),
    ]);
    return { owners, pets, appointments, medicalRecords, medicalImages, hotelBookings, dailyCareNotes, notifications };
  }
}
