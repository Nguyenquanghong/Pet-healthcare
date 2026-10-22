-- AQ-05: sessions revoked by a Core password change (identity.sessions-revoked.v1).
-- Additive; the inbox keeps the latest instant per user (out-of-order safe).
CREATE TABLE "SessionRevocation" (
    "userId" TEXT NOT NULL,
    "revokedBefore" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionRevocation_pkey" PRIMARY KEY ("userId")
);
