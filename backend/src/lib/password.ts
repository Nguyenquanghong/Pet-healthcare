import crypto from "node:crypto";
import { promisify } from "node:util";
import { Admission, integer } from '@nipopeto/runtime';

const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const derive = promisify(crypto.pbkdf2);
export const hashAdmission = new Admission(integer('HASH_CONCURRENCY',2,1,16),integer('HASH_PENDING_LIMIT',16,0,128),integer('HASH_QUEUE_TIMEOUT_MS',1250,10,5000));
const deriveBounded=(password:string,salt:Buffer)=>hashAdmission.run(()=>derive(password,salt,ITERATIONS,KEY_LENGTH,DIGEST));

export async function hashPasswordAsync(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = await deriveBounded(password, salt);
  return { passwordHash: hash.toString("base64"), passwordSalt: salt.toString("base64") };
}

export async function verifyPasswordAsync(password: string, passwordHash: string, passwordSalt: string) {
  const candidate = await deriveBounded(password, Buffer.from(passwordSalt, "base64"));
  const stored = Buffer.from(passwordHash, "base64");
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

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
