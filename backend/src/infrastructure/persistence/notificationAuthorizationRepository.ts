import type { PrismaClient } from '@prisma/client';
import type { SendAccount, SendAccountReader } from '../../application/ports/notificationAuthorization.js';

export class PrismaSendAccountReader implements SendAccountReader {
  constructor(private readonly db: PrismaClient) {}
  find(id: string): Promise<SendAccount | null> {
    return this.db.user.findUnique({ where: { id }, select: { id: true, role: true } });
  }
}
