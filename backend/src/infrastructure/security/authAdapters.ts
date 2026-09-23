import type { PasswordPort, TokenPort } from "../../application/ports/auth.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { signToken } from "../../lib/token.js";

export const passwordAdapter: PasswordPort = { hash: hashPassword, verify: verifyPassword };
export const tokenAdapter: TokenPort = { sign: signToken };
