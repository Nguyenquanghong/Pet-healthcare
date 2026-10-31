import type { Prisma, PrismaClient } from '../../generated/client/index.js';
import { BusinessError } from '../../domain/error.js';
import type {
  BookingLifecycleStore,
  LifecycleTransaction,
  BookingKind,
} from '../../application/ports/bookingLifecycle.js';
import { appointmentSlotWrite } from './appointmentSlotConflict.js';
import { writeNotification } from '../messaging/notificationOutbox.js';
import type { RequestDirectory } from '../core/directory.js';
import { appendStatusEvent, transaction, unlocked } from './shared.js';

export class Lifecycle implements BookingLifecycleStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly directory: RequestDirectory,
    private readonly bound?: Prisma.TransactionClient,
  ) {}
  async history(_kind: BookingKind, id: string) {
    if (!(await this.db.appointment.findUnique({ where: { id } })))
      throw new BusinessError(404, 'Appointment not found.');
    return this.db.bookingStatusEvent.findMany({
      where: { kind: 'appointment', bookingId: id },
      orderBy: { revision: 'desc' },
    });
  }
  run<T>(kind: BookingKind, id: string, work: (tx: LifecycleTransaction) => Promise<T>) {
    if (kind !== 'appointment') throw new BusinessError(422, 'Clinic only owns appointments.');
    return transaction(this.db, this.bound, async tx => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;
      const booking = await tx.appointment.findUnique({ where: { id } });
      if (!booking) throw new BusinessError(404, 'Appointment not found.');
      // Same lock as prepare: never mutate a HELD/INVOICED source, including notes.
      await unlocked(tx, id);
      return work({
        booking,
        dependencies: async () => ({
          medical: await tx.medicalRecord.count({ where: { appointmentId: id } }),
          invoices: await tx.appointmentReservation.count({
            where: { appointmentId: id, state: { in: ['HELD', 'INVOICED'] } },
          }),
        }),
        latestTransition: () =>
          tx.bookingStatusEvent.findFirst({
            where: { bookingId: id, action: { not: 'note_updated' } },
            orderBy: { revision: 'desc' },
          }),
        save: async (status, patch = {}) => {
          const saved = await appointmentSlotWrite(
            tx.appointment.update({
              where: { id },
              data: {
                ...patch,
                status: status as Prisma.AppointmentUpdateInput['status'],
                statusRevision: { increment: 1 },
              },
            }),
          );
          return saved;
        },
        event: (actor, action, from, to, rev, reason, original) =>
          appendStatusEvent(tx, this.directory, id, actor, action, from, to, rev, reason, original),
        notify: async (message, recipient = 'owner') => {
          await writeNotification(tx, {
            recipientOwnerId: recipient === 'owner' ? booking.ownerId : null,
            recipientRole: recipient,
            type: 'booking_status_updated',
            title: 'Appointment updated',
            message,
            relatedPetId: booking.petId,
            relatedAppointmentId: id,
            actionUrl:
              recipient === 'admin'
                ? '/admin/appointments'
                : booking.type.startsWith('spa_')
                  ? '/owner/spa-booking'
                  : '/owner/appointments',
          });
        },
      });
    });
  }
}
