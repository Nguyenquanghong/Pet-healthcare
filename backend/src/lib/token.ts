import jwt from "jsonwebtoken";
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { roles, type Role } from "../domain/auth.js";

export type AuthPayload = { sub: string; role: Role };
let cached:ReturnType<typeof readAsymmetric>|undefined;
let cachedSource:string|undefined;

export function asymmetricConfig() {
  const source=JSON.stringify(['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID'].map(k=>process.env[k]??''));
  if(source!==cachedSource){cached=readAsymmetric();cachedSource=source;}return cached??null;
}
function readAsymmetric() {
  const names = ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE'];
  if (!names.some(k => process.env[k])) return null;
  if (!['JWT_PUBLIC_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE'].every(k => process.env[k])) throw new Error('INCOMPLETE_JWT_CONFIGURATION');
  const publicKey = createPublicKey(process.env.JWT_PUBLIC_KEY!);
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('INVALID_JWT_PUBLIC_KEY');
  const privateKey = process.env.JWT_PRIVATE_KEY ? createPrivateKey(process.env.JWT_PRIVATE_KEY) : undefined;
  if (privateKey && !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw new Error('JWT_KEY_PAIR_MISMATCH');
  const keyId=process.env.JWT_KEY_ID;if(keyId!==undefined&&!/^[a-zA-Z0-9_.-]{1,64}$/.test(keyId))throw new Error('INVALID_JWT_KEY_ID');
  return { publicKey, privateKey, issuer: process.env.JWT_ISSUER!, audience: process.env.JWT_AUDIENCE!,keyId };
}

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
  return value;
}

export function signToken(userId: string, role: Role) {
  const config = asymmetricConfig();
  if (config && !config.privateKey) throw new Error('JWT_SIGNING_KEY_REQUIRED');
  return jwt.sign({ role }, config?.privateKey ?? secret(), {
    algorithm: config ? 'RS256' : 'HS256',
    ...(config ? { issuer: config.issuer, audience: config.audience,...(config.keyId?{keyid:config.keyId}:{}) } : {}),
    subject: userId,
    expiresIn: (process.env.JWT_EXPIRES_IN || "8h") as jwt.SignOptions["expiresIn"],
  });
}

// AQ-05: a token issued before the account's last password change is revoked.
// Call only after the signature was verified; iat is in seconds, so a token
// issued in the same second as the change is still accepted.
export function issuedBeforePasswordChange(token: string, passwordChangedAt: Date | null | undefined): boolean {
  if (!passwordChangedAt) return false;
  const iat = (jwt.decode(token) as { iat?: unknown } | null)?.iat;
  return typeof iat !== "number" || iat < Math.floor(passwordChangedAt.getTime() / 1000);
}

export function verifyToken(token: string): AuthPayload {
  const config = asymmetricConfig();
  if(token.length>8192)throw new Error('Invalid token payload.');
  if(config?.keyId&&jwt.decode(token,{complete:true})?.header.kid!==config.keyId)throw new Error('Invalid token key.');
  const payload = config ? jwt.verify(token, config.publicKey, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience }) : jwt.verify(token, secret(), { algorithms: ['HS256'] });
  if (typeof payload === "string" || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length>200 || !roles.includes(payload.role) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new Error("Invalid token payload.");
  return { sub: payload.sub, role: payload.role as Role };
}
