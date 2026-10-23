import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './generated/client/index.js';
import { ApiError, type Actor } from './notifications.js';
import type { SendAuthorization } from './coreAuthorization.js';
import { allows, deniedMessage } from '@nipopeto/contracts';

function input(raw: unknown, key: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(422, 'Request body must be a JSON object.');
  const data = raw as Record<string, unknown>;
  const text = (field: string, max = 10000) => {
    const value = data[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new ApiError(422, `${field} must be a non-empty string of at most ${max} characters.`);
    return value.trim();
  };
  const recipientOwnerId = text('recipientOwnerId', 200), title = text('title'), message = text('message');
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new ApiError(422, 'A valid Idempotency-Key is required.');
  return { recipientOwnerId, title, message, key, hash: createHash('sha256').update(JSON.stringify([recipientOwnerId, title, message])).digest('hex') };
}
export class ManualSend {
  constructor(private readonly db: PrismaClient, private readonly authorization?: SendAuthorization) {}
  async send(actor: Actor, actorToken: string, raw: unknown, key: unknown, fault?: () => void) {
    if (!allows(actor.role, 'notification.send')) throw new ApiError(403, deniedMessage('notification.send'));
    const data = input(raw, key), operationType = 'notification.send';
    const existing = await this.db.requestDedup.findUnique({ where: { actorId_operationType_key: { actorId: actor.sub, operationType, key: data.key } } });
    const replay = (row: { requestHash: string; responsePayload: Prisma.JsonValue }) => {
      if (row.requestHash !== data.hash) throw new ApiError(409, 'Idempotency-Key was already used with different content.');
      return row.responsePayload;
    };
    if (existing) return replay(existing);
    if (!this.authorization) throw new ApiError(503, 'Core authorization is not configured.');
    await this.authorization.authorize(actor, data.recipientOwnerId, actorToken);
    return this.db.$transaction(async tx => {
      const id = randomUUID(), resourceId = randomUUID();
      // Unique insert waits for a concurrent transaction, then observes its
      // complete response. No pending record can commit separately from effect.
      const inserted = await tx.$executeRaw`INSERT INTO "RequestDedup" ("id","actorId","operationType","key","requestHash","resourceId","responseStatus","responsePayload") VALUES (${id},${actor.sub},${operationType},${data.key},${data.hash},${resourceId},201,'{}'::jsonb) ON CONFLICT ("actorId","operationType","key") DO NOTHING`;
      if (!inserted) return replay(await tx.requestDedup.findUniqueOrThrow({ where: { actorId_operationType_key: { actorId: actor.sub, operationType, key: data.key } } }));
      const notification = await tx.notification.create({ data: { id: resourceId, recipientOwnerId: data.recipientOwnerId, recipientRole: 'owner', type: 'general', title: data.title, message: data.message, actionUrl: '/owner/notifications', sentByStaffId: actor.sub } });
      const response = JSON.parse(JSON.stringify({ notification })) as Prisma.InputJsonValue;
      await tx.requestDedup.update({ where: { id }, data: { responsePayload: response } });
      fault?.();
      return response;
    });
  }
}
