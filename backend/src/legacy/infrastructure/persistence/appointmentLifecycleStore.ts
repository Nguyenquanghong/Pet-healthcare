import type { Prisma, PrismaClient } from '@prisma/client';
import { BusinessError } from '../../../domain/error.js';
import type {
  BookingKind,
  BookingLifecycleStore,
  LifecycleTransaction,
} from '../../../application/ports/bookingLifecycle.js';
import { lifecycleByKind } from '../../../application/services/bookingLifecycle.js';
import {
  appendStatusEvent,
  PrismaHotelLifecycleStore,
} from '../../../infrastructure/persistence/bookingLifecycleRepository.js';
import { writeNotification } from '../../../infrastructure/persistence/notificationOutbox.js';
import { appointmentSlotWrite } from './appointmentSlotConflict.js';

export class PrismaAppointmentLifecycleStore implements BookingLifecycleStore {
  constructor(private readonly client: PrismaClient) {}
  async history(kind: BookingKind, id: string) {
    const exists = await this.client.appointment.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new BusinessError(404, 'Không tìm thấy lịch đặt.');
    return this.client.bookingStatusEvent.findMany({ where: { kind, bookingId: id }, orderBy: { revision: 'desc' } });
  }
  run<T>(kind: BookingKind, id: string, work: (tx: LifecycleTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
      const booking = await tx.appointment.findUnique({ where: { id } });
      if (!booking) throw new BusinessError(404, 'Không tìm thấy lịch đặt.');
      return work({
        booking,
        dependencies: async () => ({
          medical: await tx.medicalRecord.count({ where: { appointmentId: id } }),
          care: 0,
          invoices: await tx.invoice.count({
            where: { appointmentId: id },
          }),
        }),
        hotelInvoiceStatus: async () => null,
        latestTransition: () =>
          tx.bookingStatusEvent.findFirst({
            where: { kind, bookingId: id, action: { not: 'note_updated' } },
            orderBy: { revision: 'desc' },
          }),
        save: (status, patch = {}) =>
          appointmentSlotWrite(
            tx.appointment.update({
              where: { id },
              data: {
                ...patch,
                status: status as Prisma.AppointmentUpdateInput['status'],
                statusRevision: { increment: 1 },
              },
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
            relatedAppointmentId: id,
            actionUrl:
              recipientRole === 'admin'
                ? '/admin/appointments'
                : 'type' in booking && booking.type.startsWith('spa_')
                  ? '/owner/spa-booking'
                  : '/owner/appointments',
          });
        },
      });
    });
  }
}

// Both kinds behind one store, for tests that drive the whole lifecycle against Postgres.
export class PrismaBookingLifecycleStore implements BookingLifecycleStore {
  private readonly store: BookingLifecycleStore;
  constructor(client: PrismaClient) {
    this.store = lifecycleByKind({
      hotel: new PrismaHotelLifecycleStore(client),
      appointment: new PrismaAppointmentLifecycleStore(client),
    });
  }
  history(kind: BookingKind, id: string) {
    return this.store.history(kind, id);
  }
  run<T>(kind: BookingKind, id: string, work: (tx: LifecycleTransaction) => Promise<T>): Promise<T> {
    return this.store.run(kind, id, work);
  }
}
