import { ApiError, type Actor } from './notifications.js';
import { traceHeaders } from '@nipopeto/runtime';
import { deniedMessage } from '@nipopeto/contracts';

export interface SendAuthorization {
  authorize(actor: Actor, recipientOwnerId: string, actorToken: string): Promise<void>;
}
export class CoreSendAuthorization implements SendAuthorization {
  private readonly target: URL;
  constructor(coreUrl: string, private readonly credential: string, private readonly timeoutMs = 2000) {
    this.target = new URL(coreUrl);
    if (!['http:', 'https:'].includes(this.target.protocol) || this.target.pathname !== '/' || this.target.username || this.target.password || this.target.search || this.target.hash || credential.length < 32 || credential.length > 512 || timeoutMs < 1) throw new Error('INVALID_CORE_AUTH_CONFIGURATION');
  }
  async authorize(actor: Actor, recipientOwnerId: string, actorToken: string) {
    try {
      const res = await fetch(new URL('/internal/notifications/authorize-send', this.target), {
        method: 'POST', headers: { ...traceHeaders(), 'Content-Type': 'application/json', Authorization: `Bearer ${actorToken}`, 'X-Service-Token': this.credential },
        body: JSON.stringify({ recipientOwnerId }), redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 403) throw new ApiError(403, deniedMessage('notification.send'));
      if (res.status === 404) throw new ApiError(404, 'Recipient not found.');
      if (res.status !== 200) throw new Error('CORE_UNAVAILABLE');
      const value = await res.json();
      if (value.authorized !== true || value.actorId !== actor.sub || value.actorRole !== actor.role || value.recipientOwnerId !== recipientOwnerId) throw new Error('INVALID_AUTHORIZATION_RESPONSE');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'Core authorization unavailable. Retry the same request key.');
    }
  }
}
