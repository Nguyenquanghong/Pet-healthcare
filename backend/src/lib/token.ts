import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";

export type AuthPayload = { sub: string; role: Role };

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
  return value;
}

export function signToken(userId: string, role: Role) {
  return jwt.sign({ role }, secret(), {
    subject: userId,
    expiresIn: (process.env.JWT_EXPIRES_IN || "8h") as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): AuthPayload {
  const payload = jwt.verify(token, secret());
  if (typeof payload === "string" || !payload.sub || !payload.role) throw new Error("Invalid token payload.");
  return { sub: payload.sub, role: payload.role as Role };
}
