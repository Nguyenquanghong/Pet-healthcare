import { PrismaClient } from "@prisma/client";
import { databaseUrl, runtimeEnabled } from '@nipopeto/runtime';

export const prisma = new PrismaClient(runtimeEnabled()?{datasourceUrl:databaseUrl()}:undefined);
