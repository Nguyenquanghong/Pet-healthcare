import type { RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import { verifyToken } from '../lib/token.js';

// Core is the account authority. Validate current existence/role on authenticated
// API requests; a valid signature alone must not keep a deleted account active.
export function currentAccount(db: Pick<PrismaClient,'user'>): RequestHandler {
  return async (req,res,next) => {
    const publicAuth = ['/auth/owner/login','/auth/admin/login','/auth/owner/register','/auth/owner/activation','/auth/owner/activation/inspect'];
    if (req.method==='OPTIONS' || publicAuth.includes(req.path)
      || req.path==='/health' || req.path==='/openapi.json' || /^\/(public|docs)(\/|$)/.test(req.path)
      || ['/payments/vnpay/ipn','/payments/vnpay/return'].includes(req.path)) { next(); return; }
    const header=req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { next(); return; }
    let actor;
    try { actor=verifyToken(header.slice(7)); }
    catch { res.status(401).json({error:'Your session is invalid or has expired.'}); return; }
    try {
      const account=await db.user.findUnique({where:{id:actor.sub},select:{id:true,role:true}});
      if(!account) { res.status(401).json({error:'Your account is no longer available. Sign in again.'}); return; }
      if(account.role!==actor.role) { res.status(403).json({error:'Your permissions changed. Sign in again.'}); return; }
      req.auth=actor; next();
    } catch { res.status(503).json({error:'Account authorization unavailable.'}); }
  };
}
