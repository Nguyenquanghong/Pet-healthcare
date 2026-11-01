import type { Express } from 'express';
import express from 'express';
import type { NotificationSendAuthorization } from '../../application/services/notificationAuthorization.js';
import { verifyToken } from '../../lib/token.js';
import { acceptsCredential } from '@nipopeto/runtime';
import { allows, deniedMessage } from '@nipopeto/contracts';

export function mountNotificationAuthorizationRoutes(
  app: Express,
  authorization: NotificationSendAuthorization,
  credential?: string,
) {
  app.post('/internal/notifications/authorize-send', express.json({ limit: '8kb' }), async (req, res) => {
    if (!credential || credential.length < 32) {
      res.status(503).json({ error: 'Internal authorization unavailable.' });
      return;
    }
    if (!acceptsCredential(req.headers['x-service-token'], credential)) {
      res.status(401).json({ error: 'Service authentication required.' });
      return;
    }
    let actor;
    try {
      const token = req.headers.authorization;
      if (!token?.startsWith('Bearer ') || token.length > 8192) throw new Error('INVALID_TOKEN');
      actor = verifyToken(token.slice(7));
    } catch {
      res.status(401).json({ error: 'Invalid actor context.' });
      return;
    }
    if (!allows(actor.role, 'notification.send')) {
      res.status(403).json({ error: deniedMessage('notification.send') });
      return;
    }
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      typeof req.body.recipientOwnerId !== 'string' ||
      !req.body.recipientOwnerId ||
      req.body.recipientOwnerId.length > 200 ||
      Object.keys(req.body).some(k => k !== 'recipientOwnerId')
    ) {
      res.status(422).json({ error: 'Invalid recipient request.' });
      return;
    }
    try {
      const { status, ...body } = await authorization.decide(actor, req.body.recipientOwnerId);
      res.status(status).json(body);
    } catch {
      res.status(503).json({ error: 'Core authorization unavailable.' });
    }
  });
}
