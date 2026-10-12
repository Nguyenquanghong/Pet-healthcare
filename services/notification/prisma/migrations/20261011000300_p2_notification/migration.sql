-- Upgrade the retained P1 fixture without dropping rows or resetting its DB.
ALTER TABLE "ProofNotification" RENAME TO "notifications";
ALTER TABLE "notifications"
  ALTER COLUMN "recipientOwnerId" DROP NOT NULL,
  ADD COLUMN "recipientRole" TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'sent',
  ADD COLUMN "actionUrl" TEXT,
  ADD COLUMN "relatedPetId" TEXT,
  ADD COLUMN "relatedAppointmentId" TEXT,
  ADD COLUMN "relatedBookingId" TEXT,
  ADD COLUMN "sentByStaffId" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "notifications" SET "status" = 'read' WHERE "read";
ALTER TABLE "notifications" DROP COLUMN "read";
ALTER TABLE "notifications" RENAME CONSTRAINT "ProofNotification_pkey" TO "notifications_pkey";
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_status_check" CHECK ("status" IN ('sent', 'read')),
  ADD CONSTRAINT "notifications_recipient_check" CHECK (
    ("recipientRole" = 'owner' AND "recipientOwnerId" IS NOT NULL) OR
    ("recipientRole" = 'admin' AND "recipientOwnerId" IS NULL));
CREATE INDEX "notifications_recipientOwnerId_createdAt_id_idx" ON "notifications"("recipientOwnerId", "createdAt", "id");
CREATE INDEX "notifications_recipientRole_createdAt_id_idx" ON "notifications"("recipientRole", "createdAt", "id");
