import express, { type ErrorRequestHandler } from 'express';
import type { PrismaClient } from './generated/client/index.js';
import { ApiError, Notifications, type Actor } from './notifications.js';
import { ManualSend } from './manualSend.js';
import type { SendAuthorization } from './coreAuthorization.js';
import type { ServiceRuntime } from '@nipopeto/runtime';
import { requestActor } from '@nipopeto/runtime';
import { sessionRevoked } from './sessions.js';

export function createApp(
  db: PrismaClient,
  verify?: (token: string) => Actor,
  authorization?: SendAuthorization,
  runtime?: ServiceRuntime,
) {
  const app = express();
  app.disable('x-powered-by');
  runtime?.install(app);
  const service = new Notifications(db);
  const manual = new ManualSend(db, authorization);
  app.get('/health/live', (_req, res) => res.json({ service: 'notification', status: 'alive' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await db.inboxEvent.count();
      await db.notification.count();
      await db.requestDedup.count();
      res.json({ service: 'notification', status: 'ready' });
    } catch {
      res.status(503).json({ service: 'notification', status: 'unavailable' });
    }
  });
  const router = express.Router();
  router.use(async (req, res, next) => {
    if (!verify) {
      res.status(503).json({ error: 'Notification authentication is not configured.' });
      return;
    }
    const token = req.headers.authorization;
    if (!token?.startsWith('Bearer ') || token.length > 8192) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    try {
      res.locals.actor = requestActor(req, verify);
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }
    try {
      if (await sessionRevoked(db, res.locals.actor.sub, token.slice(7))) {
        res.status(401).json({ error: 'Your password was changed. Sign in again.', code: 'SESSION_REVOKED' });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });
  router.post('/send', express.json({ limit: '96kb' }), async (req, res) => {
    const response = await manual.send(
      res.locals.actor,
      req.headers.authorization!.slice(7),
      req.body ?? {},
      req.headers['idempotency-key'],
    );
    res.status(201).json(response);
  });
  router.get('/', async (req, res) => res.json(await service.list(res.locals.actor, req.query)));
  router.get('/unread-count', async (_req, res) => res.json(await service.unread(res.locals.actor)));
  router.patch('/read-all', async (_req, res) => {
    await service.markAllRead(res.locals.actor);
    res.json({ message: 'Notifications marked as read.' });
  });
  router.patch('/:id/read', async (req, res) =>
    res.json({ notification: await service.markRead(res.locals.actor, req.params.id) }),
  );
  router.delete('/:id', async (req, res) => {
    await service.delete(res.locals.actor, req.params.id);
    res.status(204).end();
  });
  app.use('/api/notifications', router);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof ApiError) res.status(error.status).json({ error: error.message });
    else if (error?.type === 'entity.parse.failed') res.status(400).json({ error: 'Request body must be valid JSON.' });
    else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'Request body is too large.' });
    else res.status(503).json({ error: 'Notification service unavailable.' });
  };
  app.use(errors);
  return app;
}
