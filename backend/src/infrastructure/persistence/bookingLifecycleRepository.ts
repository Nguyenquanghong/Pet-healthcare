import type { Prisma, PrismaClient } from "@prisma/client";
import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { BookingKind, BookingLifecycleStore, LifecycleTransaction } from "../../application/ports/bookingLifecycle.js";
import { appointmentSlotWrite } from "./appointmentSlotConflict.js";

export async function appendStatusEvent(tx: Prisma.TransactionClient, kind: BookingKind, bookingId: string, actor: Actor,
  action: string, fromStatus: string, toStatus: string, revision: number, reason?: string, reversesId?: string) {
  const person = await tx.user.findUnique({ where: { id: actor.sub }, select: { fullName: true } });
  await tx.bookingStatusEvent.create({ data: { kind, bookingId, actorId: actor.sub, actorName: person?.fullName || actor.sub,
    actorRole: actor.role, action, fromStatus, toStatus, revision, reason, reversesId } });
}
export class PrismaBookingLifecycleStore implements BookingLifecycleStore {
  constructor(private readonly client: PrismaClient) {}
  async history(kind: BookingKind, id: string) {
    const exists = kind === "appointment" ? await this.client.appointment.findUnique({ where: { id }, select: { id: true } })
      : await this.client.hotelBooking.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new BusinessError(404, "Không tìm thấy lịch đặt.");
    return this.client.bookingStatusEvent.findMany({ where: { kind, bookingId: id }, orderBy: { revision: "desc" } });
  }
  run<T>(kind: BookingKind, id: string, work: (tx: LifecycleTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(async tx => {
      if (kind === "appointment") await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;
      const booking = kind === "appointment" ? await tx.appointment.findUnique({ where: { id } })
        : await tx.hotelBooking.findUnique({ where: { id }, include: { dailyCareNotes: { select: { id: true } } } });
      if (!booking) throw new BusinessError(404, "Không tìm thấy lịch đặt.");
      return work({
        booking,
        dependencies: async () => ({
          medical: kind === "appointment" ? await tx.medicalRecord.count({ where: { appointmentId: id } }) : 0,
          care: kind === "hotel" ? await tx.dailyCareNote.count({ where: { bookingId: id } }) : 0,
          invoices: await tx.invoice.count({ where: kind === "appointment" ? { appointmentId: id } : { hotelBookingId: id } }),
        }),
        hotelInvoiceStatus: async () => {
          if (kind !== "hotel") return null;
          const invoice = await tx.invoice.findUnique({ where: { hotelBookingId: id }, select: { id: true } });
          if (!invoice) return null;
          // Payment confirmation locks the invoice row. Reading under the same lock
          // makes checkout observe the committed payment result.
          await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoice.id} FOR UPDATE`;
          return (await tx.invoice.findUnique({ where: { id: invoice.id }, select: { paymentStatus: true } }))?.paymentStatus ?? null;
        },
        latestTransition: () => tx.bookingStatusEvent.findFirst({ where: { kind, bookingId: id, action: { not: "note_updated" } }, orderBy: { revision: "desc" } }),
        save: (status, patch = {}) => kind === "appointment"
          ? appointmentSlotWrite(tx.appointment.update({ where: { id }, data: { ...patch, status: status as Prisma.AppointmentUpdateInput["status"], statusRevision: { increment: 1 } } }))
          : tx.hotelBooking.update({ where: { id }, data: { internalNote: patch.internalNote, ownerNote: patch.ownerNote,
            status: status as Prisma.HotelBookingUpdateInput["status"], statusRevision: { increment: 1 } }, include: { dailyCareNotes: { select: { id: true } } } }),
        event: (actor, action, from, to, version, reason, original) => appendStatusEvent(tx, kind, id, actor, action, from, to, version, reason, original),
        notify: async (message, recipientRole = "owner") => { await tx.notification.create({ data: {
          recipientOwnerId: recipientRole === "owner" ? booking.ownerId : undefined, recipientRole, type: "booking_status_updated", title: "Cập nhật lịch dịch vụ", message,
          relatedPetId: booking.petId, ...(kind === "appointment" ? { relatedAppointmentId: id } : { relatedBookingId: id }),
          actionUrl: recipientRole === "admin" ? "/admin/appointments" : kind === "hotel" ? "/owner/hotel-booking" : "type" in booking && booking.type.startsWith("spa_") ? "/owner/spa-booking" : "/owner/appointments",
        } }); },
      });
    });
  }
}
