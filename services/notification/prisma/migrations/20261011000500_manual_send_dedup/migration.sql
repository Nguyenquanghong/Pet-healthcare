CREATE TABLE "RequestDedup" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responsePayload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RequestDedup_actorId_operationType_key_key" ON "RequestDedup"("actorId", "operationType", "key");
