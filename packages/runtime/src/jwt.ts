import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
export type Actor = { sub: string; role: 'owner' | 'doctor' | 'staff' | 'admin' };
type Verifier = (token: string) => Actor;
// Only results produced by this helper are reusable, never req.auth supplied by
// another middleware. Request identity + exact token + verifier bound the cache.
const verifiedRequests = new WeakMap<object, { token: string; verify: Verifier; actor: Actor | null }>();
export function requestActor(req: Pick<Request, 'headers'>, verify: Verifier): Actor {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length > 8192) throw new Error('INVALID_ACTOR');
  const token = header.slice(7),
    cached = verifiedRequests.get(req);
  if (cached?.token === token && cached.verify === verify) {
    if (!cached.actor) throw new Error('INVALID_ACTOR');
    return cached.actor;
  }
  try {
    const value = verify(token),
      actor = Object.freeze({ sub: value.sub, role: value.role });
    verifiedRequests.set(req, { token, verify, actor });
    return actor;
  } catch {
    verifiedRequests.set(req, { token, verify, actor: null });
    throw new Error('INVALID_ACTOR');
  }
}
export function publicVerifier(config: { publicKey: string; issuer: string; audience: string; keyId?: string }) {
  const key = createPublicKey(config.publicKey);
  if (
    key.asymmetricKeyType !== 'rsa' ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
    !config.issuer ||
    !config.audience ||
    (config.keyId !== undefined && !/^[a-zA-Z0-9_.-]{1,64}$/.test(config.keyId))
  )
    throw new Error('INVALID_AUTH_CONFIGURATION');
  return (token: string): Actor => {
    if (token.length > 8192) throw new Error('INVALID_ACTOR');
    const decoded = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: config.audience,
      complete: true,
    });
    const p = decoded.payload;
    if (
      (config.keyId && decoded.header.kid !== config.keyId) ||
      typeof p === 'string' ||
      typeof p.sub !== 'string' ||
      !p.sub ||
      p.sub.length > 200 ||
      !['owner', 'doctor', 'staff', 'admin'].includes(p.role) ||
      typeof p.exp !== 'number' ||
      !Number.isFinite(p.exp)
    )
      throw new Error('INVALID_ACTOR');
    return { sub: p.sub, role: p.role };
  };
}
