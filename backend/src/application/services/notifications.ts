import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { NotificationRepository } from "../ports/notifications.js";

export type SendNotificationInput = { recipientOwnerId?: string; title?: string; message?: string };

export class NotificationsService {
  constructor(private readonly notifications: NotificationRepository) {}

  private scope(actor: Actor) {
    return actor.role === "owner" ? { recipientOwnerId: actor.sub } : { recipientRole: "admin" };
  }

  list(actor: Actor) {
    return this.notifications.list(this.scope(actor));
  }

  async markAllRead(actor: Actor) {
    await this.notifications.markAllRead(this.scope(actor));
  }

  async markRead(actor: Actor, id: string) {
    const item = await this.notifications.findVisible(id, actor.role === "owner" ? actor.sub : undefined);
    if (!item) throw new BusinessError(404, "Notification not found.");
    return this.notifications.markRead(item.id);
  }

  async delete(actor: Actor, id: string) {
    const item = await this.notifications.findVisible(id, actor.role === "owner" ? actor.sub : undefined);
    if (!item) throw new BusinessError(404, "Notification not found.");
    await this.notifications.delete(item.id);
  }

  async send(actor: Actor, input: SendNotificationInput) {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    if (!input.recipientOwnerId || !input.title?.trim() || !input.message?.trim()) throw new BusinessError(422, "Recipient, title, and message are required.");
    return this.notifications.send({
      recipientOwnerId: input.recipientOwnerId, recipientRole: "owner", type: "general",
      title: input.title.trim(), message: input.message.trim(), actionUrl: "/owner/notifications",
      sentByStaffId: actor.sub,
    });
  }
}
