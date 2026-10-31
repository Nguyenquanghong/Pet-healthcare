import type { Prisma, PrismaClient } from '../../generated/client/index.js';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import { writeNotification } from '../messaging/notificationOutbox.js';
import type { RequestDirectory } from '../core/directory.js';

export type Client = PrismaClient | Prisma.TransactionClient;
export const transaction = <T>(
  db: PrismaClient,
  bound: Prisma.TransactionClient | undefined,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) => (bound ? work(bound) : db.$transaction(work));
export async function unlocked(tx: Client, id: string) {
  if (await tx.appointmentReservation.count({ where: { appointmentId: id, state: { in: ['HELD', 'INVOICED'] } } }))
    throw new BusinessError(409, 'Appointment is reserved or already invoiced.');
}
export async function appendStatusEvent(
  tx: Client,
  directory: RequestDirectory,
  id: string,
  actor: Actor,
  action: string,
  fromStatus: string,
  toStatus: string,
  revision: number,
  reason?: string,
  reversesId?: string,
) {
  await tx.bookingStatusEvent.create({
    data: {
      kind: 'appointment',
      bookingId: id,
      actorId: actor.sub,
      actorName: directory.snapshot.actor.fullName,
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
export const writer = (db: Client) => ({
  create: async (draft: {
    recipientOwnerId?: string;
    recipientRole: string;
    title: string;
    message: string;
    type: string;
    actionUrl: string;
    relatedPetId: string;
    relatedAppointmentId: string | null;
  }) => {
    await writeNotification(db, {
      ...draft,
      recipientOwnerId: draft.recipientOwnerId ?? null,
      recipientRole: draft.recipientRole as 'owner' | 'admin',
    });
  },
});
