import type { NextFunction, Request, Response } from "express";
import type { Role } from "../domain/auth.js";
import { verifyToken, type AuthPayload } from "../lib/token.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication is required." });
  try {
    req.auth = verifyToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: "Your session is invalid or has expired." });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: "You do not have permission to perform this action." });
    next();
  };
}
