import crypto from "node:crypto";

const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

export function hashPassword(password: string) {
  const passwordSalt = crypto.randomBytes(16).toString("base64");
  const passwordHash = crypto
    .pbkdf2Sync(password, Buffer.from(passwordSalt, "base64"), ITERATIONS, KEY_LENGTH, DIGEST)
    .toString("base64");
  return { passwordHash, passwordSalt };
}

export function verifyPassword(password: string, passwordHash: string, passwordSalt: string) {
  const candidate = crypto.pbkdf2Sync(
    password,
    Buffer.from(passwordSalt, "base64"),
    ITERATIONS,
    KEY_LENGTH,
    DIGEST,
  );
  const stored = Buffer.from(passwordHash, "base64");
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}
