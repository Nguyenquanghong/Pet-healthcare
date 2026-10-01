import { createHash, randomBytes } from "node:crypto";
import type { ActivationTokenPort } from "../../application/ports/ownerActivation.js";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const activationTokenAdapter: ActivationTokenPort = {
  hash,
  create() { const token = randomBytes(32).toString("base64url"); return { token, tokenHash: hash(token) }; },
};
