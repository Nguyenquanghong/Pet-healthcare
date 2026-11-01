import type { Actor, Role } from '../../domain/auth.js';
import type { SendAccountReader } from '../ports/notificationAuthorization.js';

export type SendRefusal = { status: 403 | 404; error: string };
export type SendGrant = { status: 200; actorId: string; actorRole: Role; recipientOwnerId: string; authorized: true };
export type SendDecision = SendRefusal | SendGrant;

// The part of authorize-send that reads accounts: the sender is still staff, the recipient is an owner.
// The route has already checked the token, the permission matrix and the shape of the request.
export class NotificationSendAuthorization {
  constructor(private readonly accounts: SendAccountReader) {}
  async decide(actor: Actor, recipientOwnerId: string): Promise<SendDecision> {
    const sender = await this.accounts.find(actor.sub);
    if (!sender || sender.role !== actor.role) return { status: 403, error: 'Staff access is required.' };
    const recipient = await this.accounts.find(recipientOwnerId);
    if (!recipient || recipient.role !== 'owner') return { status: 404, error: 'Recipient not found.' };
    return {
      status: 200,
      actorId: sender.id,
      actorRole: sender.role,
      recipientOwnerId: recipient.id,
      authorized: true,
    };
  }
}
