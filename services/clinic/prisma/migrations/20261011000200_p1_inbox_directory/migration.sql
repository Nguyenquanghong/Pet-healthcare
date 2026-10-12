CREATE TABLE "InboxEvent" (
  "consumerName" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("consumerName", "eventId")
);
CREATE TABLE "DirectoryProjection" (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "displayName" TEXT NOT NULL,
  "ownerId" TEXT,
  species TEXT,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "DirectoryProjection_pkey" PRIMARY KEY (kind, id),
  CONSTRAINT "DirectoryProjection_version_check" CHECK ("sourceVersion" > 0)
);
