const HASH_ITERATIONS = 210000;
const HASH_ALGORITHM = "SHA-256";
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derivePasswordHash(password: string, salt: string) {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: HASH_ALGORITHM,
      salt: base64ToBytes(salt),
      iterations: HASH_ITERATIONS,
    },
    passwordKey,
    KEY_BYTES * 8,
  );
  return bytesToBase64(new Uint8Array(derivedBits));
}

export async function hashPassword(password: string) {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const passwordSalt = bytesToBase64(salt);
  const passwordHash = await derivePasswordHash(password, passwordSalt);
  return { passwordHash, passwordSalt };
}

export async function verifyPassword(password: string, passwordHash?: string, passwordSalt?: string) {
  if (!passwordHash || !passwordSalt) return false;
  const candidateHash = await derivePasswordHash(password, passwordSalt);
  return candidateHash === passwordHash;
}
