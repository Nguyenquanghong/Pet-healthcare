export type NotificationValue = {
  id: string; recipientOwnerId: string | null; recipientRole: string; type: string;
  title: string; message: string; status: string; actionUrl: string | null;
  relatedPetId: string | null; relatedAppointmentId: string | null; relatedBookingId: string | null;
  sentByStaffId: string | null; createdAt: Date; sentAt: Date;
};

export interface NotificationRepository {
  list(scope: { recipientOwnerId: string } | { recipientRole: string }): Promise<NotificationValue[]>;
  markAllRead(scope: { recipientOwnerId: string } | { recipientRole: string }): Promise<void>;
  findVisible(id: string, ownerId?: string): Promise<NotificationValue | null>;
  markRead(id: string): Promise<NotificationValue>;
  delete(id: string): Promise<void>;
  send(data: { recipientOwnerId: string; recipientRole: string; type: string; title: string; message: string; actionUrl: string; sentByStaffId: string }): Promise<NotificationValue>;
}
