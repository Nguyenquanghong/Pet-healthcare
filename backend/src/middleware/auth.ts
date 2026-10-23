import type { NextFunction, Request, Response } from "express";
import { allows, deniedMessage, type Permission } from "@nipopeto/contracts";
import { verifyToken, type AuthPayload } from "../lib/token.js";
import { requestActor } from '@nipopeto/runtime';

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
    req.auth = requestActor(req,verifyToken);
    next();
  } catch {
    return res.status(401).json({ error: "Your session is invalid or has expired." });
  }
}

// AQ-05: route-level guard over the shared permission matrix (@nipopeto/contracts).
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !allows(req.auth.role, permission)) return res.status(403).json({ error: deniedMessage(permission) });
    next();
  };
}
