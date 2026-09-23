import type { PrismaClient } from "@prisma/client";
import type { NotificationRepository } from "../../application/ports/notifications.js";

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly client: PrismaClient) {}

  list(scope: Parameters<NotificationRepository["list"]>[0]) {
    return this.client.notification.findMany({ where: scope, orderBy: { createdAt: "desc" } });
  }
  async markAllRead(scope: Parameters<NotificationRepository["markAllRead"]>[0]) {
    await this.client.notification.updateMany({ where: scope, data: { status: "read" } });
  }
  findVisible(id: string, ownerId?: string) {
    return this.client.notification.findFirst({ where: { id, ...(ownerId ? { recipientOwnerId: ownerId } : {}) } });
  }
  markRead(id: string) {
    return this.client.notification.update({ where: { id }, data: { status: "read" } });
  }
  async delete(id: string) {
    await this.client.notification.delete({ where: { id } });
  }
  send(data: Parameters<NotificationRepository["send"]>[0]) {
    return this.client.notification.create({ data });
  }
}
