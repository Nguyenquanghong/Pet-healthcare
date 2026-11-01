import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { corsOrigins } from './config.js';

export function applySecurity(app: Express, { exposedHeaders }: { exposedHeaders?: string[] } = {}) {
  app.disable('x-powered-by');
  app.use(helmet());
  const origins = corsOrigins();
  app.use(cors({ origin: origins.length ? origins : false, credentials: true, exposedHeaders }));
}

export function applyJsonBody(app: Express) {
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      req.body ??= {};
      if (typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(422).json({ error: 'Request body must be a JSON object.' });
        return;
      }
    }
    next();
  });
}
