import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { DirectoryAuthorization } from '../application/services/directoryAuthorization.js';
import { PrismaDirectoryReader } from '../infrastructure/persistence/directoryRepository.js';
import { issuedBeforePasswordChange } from '../lib/token.js';
import { mountDirectoryRoutes } from '../routes/internal/directory.js';

// The directory endpoints over Prisma: the routes get the service and the reader, never the client.
export function mountDirectory(app: Express, db: PrismaClient, credential?: string) {
  const reader = new PrismaDirectoryReader(db);
  mountDirectoryRoutes(app, new DirectoryAuthorization(reader, issuedBeforePasswordChange), reader, credential);
}
