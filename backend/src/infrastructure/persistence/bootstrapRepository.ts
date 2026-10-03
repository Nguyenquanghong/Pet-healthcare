import { Prisma, type PrismaClient } from "@prisma/client";
import type { BootstrapRepository, BootstrapSummary } from "../../application/ports/bootstrap.js";
import { emptyListData } from "./listsRepository.js";
import { todayInVietnam } from "../../domain/validation.js";

export class PrismaBootstrapRepository implements BootstrapRepository {
  constructor(private readonly client: PrismaClient) {}
  async load(isAdmin: boolean, ownerId?: string, view: "session" | "dashboard" = "session") {
    return this.client.$transaction(async tx => {
      const data = emptyListData();
      const own = ownerId ? { ownerId } : {};
      const notificationsWhere = isAdmin ? { recipientRole: "admin" } : { recipientOwnerId: ownerId! };
      const summary: BootstrapSummary = { totals: { owners: 0, pets: 0, appointments: 0, medicalRecords: 0, medicalImages: 0, hotelBookings: 0, dailyCareNotes: 0, notifications: 0 }, species: {}, appointmentStatus: {}, hotelStatus: {}, notificationCategory: {}, unread: 0, todayAppointments: 0 };
      summary.unread = await tx.notification.count({ where: { ...notificationsWhere, status: "sent" } });
      if (ownerId) {
        data.owners = await tx.user.findMany({ where: { id: ownerId }, include: { pets: { select: { id: true }, take: 0 }, _count: { select: { pets: true } } } });
        data.pets = await tx.pet.findMany({ where: own, take: view === "dashboard" ? 6 : 20, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        summary.totals.pets = await tx.pet.count({ where: own });
      }
      if (view === "dashboard") {
        const today = new Date(`${todayInVietnam()}T00:00:00Z`);
        const [owners, pets, appointments, hotels, medical, images, notes, notifications, species, appointmentStatus, hotelStatus, types, todayCount] = await Promise.all([
          tx.user.count({ where: isAdmin ? { role: "owner" } : { id: ownerId } }), tx.pet.count({ where: own }),
          tx.appointment.count({ where: own }), tx.hotelBooking.count({ where: own }), tx.medicalRecord.count({ where: own }),
          tx.medicalImage.count({ where: ownerId ? { pet: own } : {} }), tx.dailyCareNote.count({ where: ownerId ? { booking: own, visibleToOwner: true } : {} }),
          tx.notification.count({ where: notificationsWhere }), tx.pet.groupBy({ by: ["species"], where: own, _count: true }),
          tx.appointment.groupBy({ by: ["status"], where: own, _count: true }), tx.hotelBooking.groupBy({ by: ["status"], where: own, _count: true }),
          tx.notification.groupBy({ by: ["type"], where: notificationsWhere, _count: true }), tx.appointment.count({ where: { ...own, appointmentDate: today } }),
        ]);
        summary.totals = { owners, pets, appointments, hotelBookings: hotels, medicalRecords: medical, medicalImages: images, dailyCareNotes: notes, notifications };
        summary.species = Object.fromEntries(species.map(row => [row.species, row._count]));
        summary.appointmentStatus = Object.fromEntries(appointmentStatus.map(row => [row.status, row._count]));
        summary.hotelStatus = Object.fromEntries(hotelStatus.map(row => [row.status, row._count]));
        for (const row of types) { const category = row.type.startsWith("appointment_") ? "appointments" : row.type.startsWith("hotel_") ? "hotel" : ["medical_record_updated", "vaccination_reminder"].includes(row.type) ? "medical" : "promo"; summary.notificationCategory[category] = (summary.notificationCategory[category] ?? 0) + row._count; }
        summary.todayAppointments = todayCount;
        if (isAdmin) {
          const [todayRows, pendingRows] = await Promise.all([
            tx.appointment.findMany({ where: { appointmentDate: today }, take: 5, orderBy: [{ appointmentTime: "asc" }, { id: "asc" }] }),
            tx.appointment.findMany({ where: { status: "pending" }, take: 3, orderBy: [{ appointmentDate: "asc" }, { id: "asc" }] }),
          ]);
          data.appointments = [...new Map([...todayRows, ...pendingRows].map(row => [row.id, row])).values()];
          const [pending, active] = await Promise.all([
            tx.hotelBooking.findMany({ where: { status: "pending" }, take: 5, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
            tx.hotelBooking.findMany({ where: { status: "in_stay" }, take: 5, orderBy: [{ checkIn: "asc" }, { id: "asc" }] }),
          ]);
          data.hotelBookings = [...pending, ...active];
        } else {
          data.appointments = await tx.appointment.findMany({ where: { ...own, status: { in: ["pending", "confirmed"] }, appointmentDate: { gte: today } }, take: 5, orderBy: [{ appointmentDate: "asc" }, { appointmentTime: "asc" }, { id: "asc" }] });
          data.hotelBookings = await tx.hotelBooking.findMany({ where: { ...own, status: { in: ["in_stay", "confirmed"] } }, take: 5, orderBy: [{ checkIn: "asc" }, { id: "asc" }] });
        }
        data.medicalRecords = await tx.medicalRecord.findMany({ where: own, take: isAdmin ? 4 : 1, orderBy: [{ visitDate: "desc" }, { id: "desc" }] });
        data.notifications = await tx.notification.findMany({ where: notificationsWhere, take: 5, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        const ids = [...new Set([...data.appointments, ...data.hotelBookings, ...data.medicalRecords].map(row => row.petId))];
        const relatedPets = await tx.pet.findMany({ where: { id: { in: ids }, ...own } });
        data.pets = [...new Map([...data.pets, ...relatedPets].map(row => [row.id, row])).values()];
        if (isAdmin) data.owners = await tx.user.findMany({ where: { id: { in: [...new Set(data.pets.map(pet => pet.ownerId))] } }, include: { pets: { select: { id: true }, take: 0 } } });
      }
      return { ...data, summary };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
