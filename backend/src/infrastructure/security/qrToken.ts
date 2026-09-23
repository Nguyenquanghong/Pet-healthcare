import crypto from "node:crypto";
import type { QrTokenPort } from "../../application/ports/pets.js";

export const qrTokenAdapter: QrTokenPort = { create: () => crypto.randomBytes(18).toString("base64url") };
