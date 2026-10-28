import type { PrismaClient } from './generated/client/index.js';

// AQ-05: same rule as Core (backend/src/lib/token.ts issuedBeforePasswordChange):
// a token whose iat (whole seconds) is before the user's last password change is
// revoked. The instant comes from Core's identity.sessions-revoked.v1 event, so
// Notification never calls Core on a read. Call only after the signature was verified.
export async function sessionRevoked(db: PrismaClient, userId: string, token: string): Promise<boolean> {
  const row = await db.sessionRevocation.findUnique({ where: { userId }, select: { revokedBefore: true } });
  if (!row) return false;
  let iat: unknown;
  try {
    iat = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.iat;
  } catch {
    return true;
  }
  return typeof iat !== 'number' || iat < Math.floor(row.revokedBefore.getTime() / 1000);
}
