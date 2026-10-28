import { publicVerifier } from '@nipopeto/runtime';
export function actorVerifier(config: { publicKey: string; issuer: string; audience: string; keyId?: string }) {
  return publicVerifier({ ...config, ...(process.env.JWT_KEY_ID ? { keyId: process.env.JWT_KEY_ID } : {}) });
}
