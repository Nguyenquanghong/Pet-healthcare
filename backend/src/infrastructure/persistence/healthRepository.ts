import type { PrismaClient } from "@prisma/client";

export function databaseHealthCheck(client: PrismaClient) {
  return async () => {
    await client.$queryRaw`SELECT 1`;
  };
}
