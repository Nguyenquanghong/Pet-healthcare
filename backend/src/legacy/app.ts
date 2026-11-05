import express from "express";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import { BusinessError } from "../domain/error.js";
import { applyJsonBody, applySecurity } from "../composition/http.js";
import { mountCoreRoutes } from "../composition/coreRoutes.js";

export function createApp(client: PrismaClient, { clinical = true }: { clinical?: boolean } = {}) {
  const app = express();

  if (process.env.TRUST_PROXY_HOPS === "1") app.set("trust proxy", 1);
  applySecurity(app);
  applyJsonBody(app);

  mountCoreRoutes(app, client, { clinical, monolith: { authLimiter: rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests, please try again later." } }) } });

  app.use((req, res) => res.status(404).json({ error: `Route ${req.originalUrl} was not found.` }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const bodyError = error as { type?: string } | null;
    if (bodyError?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    if (bodyError?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}
