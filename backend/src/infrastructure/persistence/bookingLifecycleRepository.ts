import type { Prisma, PrismaClient } from '@prisma/client';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import type {
  BookingKind,
  BookingLifecycleStore,
  LifecycleTransaction,
} from '../../application/ports/bookingLifecycle.js';
import { writeNotification } from './notificationOutbox.js';
import { hotelStayWrite } from './hotelStayConflict.js';

export async function appendStatusEvent(
  tx: Prisma.TransactionClient,
  kind: BookingKind,
  bookingId: string,
  actor: Actor,
  action: string,
  fromStatus: string,
  toStatus: string,
  revision: number,
  reason?: string,
  reversesId?: string,
) {
  const person = await tx.user.findUnique({ where: { id: actor.sub }, select: { fullName: true } });
  await tx.bookingStatusEvent.create({
    data: {
      kind,
      bookingId,
      actorId: actor.sub,
      actorName: person?.fullName || actor.sub,
      actorRole: actor.role,
      action,
      fromStatus,
      toStatus,
      revision,
      reason,
      reversesId,
    },
  });
}
export class PrismaHotelLifecycleStore implements BookingLifecycleStore {
  constructor(private readonly client: PrismaClient) {}
  async history(kind: BookingKind, id: string) {
    const exists = await this.client.hotelBooking.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new BusinessError(404, 'Không tìm thấy lịch đặt.');
    return this.client.bookingStatusEvent.findMany({ where: { kind, bookingId: id }, orderBy: { revision: 'desc' } });
  }
  run<T>(kind: BookingKind, id: string, work: (tx: LifecycleTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;
      const booking = await tx.hotelBooking.findUnique({
        where: { id },
        include: { dailyCareNotes: { select: { id: true } } },
      });
      if (!booking) throw new BusinessError(404, 'Không tìm thấy lịch đặt.');
      return work({
        booking,
        dependencies: async () => ({
          medical: 0,
          care: await tx.dailyCareNote.count({ where: { bookingId: id } }),
          invoices: await tx.invoice.count({
            where: { hotelBookingId: id },
          }),
        }),
        hotelInvoiceStatus: async () => {
          const invoice = await tx.invoice.findUnique({ where: { hotelBookingId: id }, select: { id: true } });
          if (!invoice) return null;
          // Payment confirmation locks the invoice row. Reading under the same lock
          // makes checkout observe the committed payment result.
          await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoice.id} FOR UPDATE`;
          return (
            (await tx.invoice.findUnique({ where: { id: invoice.id }, select: { paymentStatus: true } }))
              ?.paymentStatus ?? null
          );
        },
        latestTransition: () =>
          tx.bookingStatusEvent.findFirst({
            where: { kind, bookingId: id, action: { not: 'note_updated' } },
            orderBy: { revision: 'desc' },
          }),
        save: (status, patch = {}) =>
          hotelStayWrite(
            tx.hotelBooking.update({
              where: { id },
              data: {
                internalNote: patch.internalNote,
                ownerNote: patch.ownerNote,
                status: status as Prisma.HotelBookingUpdateInput['status'],
                statusRevision: { increment: 1 },
              },
              include: { dailyCareNotes: { select: { id: true } } },
            }),
          ),
        event: (actor, action, from, to, version, reason, original) =>
          appendStatusEvent(tx, kind, id, actor, action, from, to, version, reason, original),
        notify: async (message, recipientRole = 'owner') => {
          await writeNotification(tx, {
            recipientOwnerId: recipientRole === 'owner' ? booking.ownerId : undefined,
            recipientRole,
            type: 'booking_status_updated',
            title: 'Cập nhật lịch dịch vụ',
            message,
            relatedPetId: booking.petId,
            relatedBookingId: id,
            actionUrl: recipientRole === 'admin' ? '/admin/appointments' : '/owner/hotel-booking',
          });
        },
      });
    });
  }
}
