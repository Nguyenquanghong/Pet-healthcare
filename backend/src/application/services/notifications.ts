import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import { objectInput, requiredText } from "../../domain/validation.js";
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
    const scope = this.scope(actor);
    const item = await this.notifications.findVisible(id, scope);
    if (!item) throw new BusinessError(404, "Notification not found.");
    const updated = await this.notifications.markRead(item.id, scope);
    if (!updated) throw new BusinessError(404, "Notification not found.");
    return updated;
  }

  async delete(actor: Actor, id: string) {
    const scope = this.scope(actor);
    const item = await this.notifications.findVisible(id, scope);
    if (!item) throw new BusinessError(404, "Notification not found.");
    if (!await this.notifications.delete(item.id, scope)) throw new BusinessError(404, "Notification not found.");
  }

  async send(actor: Actor, input: SendNotificationInput) {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    objectInput(input);
    const recipientOwnerId = requiredText(input.recipientOwnerId, "Recipient", 200);
    const title = requiredText(input.title, "Title"), message = requiredText(input.message, "Message");
    return this.notifications.send({
      recipientOwnerId, recipientRole: "owner", type: "general",
      title, message, actionUrl: "/owner/notifications",
      sentByStaffId: actor.sub,
    });
  }
}
