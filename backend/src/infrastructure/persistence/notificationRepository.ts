import type { PrismaClient } from "@prisma/client";
import type { NotificationRepository, NotificationScope } from "../../application/ports/notifications.js";

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly client: PrismaClient) {}

  list(scope: Parameters<NotificationRepository["list"]>[0]) {
    return this.client.notification.findMany({ where: scope, orderBy: { createdAt: "desc" } });
  }
  async markAllRead(scope: Parameters<NotificationRepository["markAllRead"]>[0]) {
    await this.client.notification.updateMany({ where: scope, data: { status: "read" } });
  }
  findVisible(id: string, scope: NotificationScope) {
    return this.client.notification.findFirst({ where: { id, ...scope } });
  }
  async markRead(id: string, scope: NotificationScope) {
    const result = await this.client.notification.updateMany({ where: { id, ...scope }, data: { status: "read" } });
    return result.count ? this.findVisible(id, scope) : null;
  }
  async delete(id: string, scope: NotificationScope) {
    const result = await this.client.notification.deleteMany({ where: { id, ...scope } });
    return result.count > 0;
  }
  send(data: Parameters<NotificationRepository["send"]>[0]) {
    return this.client.notification.create({ data });
  }
}
