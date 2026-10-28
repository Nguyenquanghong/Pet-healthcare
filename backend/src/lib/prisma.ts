import { PrismaClient } from "@prisma/client";
import { prismaClient } from '@nipopeto/runtime';

export const prisma = prismaClient(PrismaClient);
