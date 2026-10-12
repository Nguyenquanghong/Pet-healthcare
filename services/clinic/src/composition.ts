import { PrismaClient } from './generated/client/index.js';
import { databaseUrl, runtimeEnabled } from '@nipopeto/runtime';
export const createDependencies = () => ({ db: new PrismaClient(runtimeEnabled()?{datasourceUrl:databaseUrl()}:undefined) });
