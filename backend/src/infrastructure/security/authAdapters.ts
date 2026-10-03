import type { PasswordPort, TokenPort } from "../../application/ports/auth.js";
import { hashPasswordAsync, verifyPasswordAsync } from "../../lib/password.js";
import { signToken } from "../../lib/token.js";

export const passwordAdapter: PasswordPort = { hash: hashPasswordAsync, verify: verifyPasswordAsync };
export const tokenAdapter: TokenPort = { sign: signToken };
