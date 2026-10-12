-- Additive runtime protocol; preserve legacy rows and unique appointment_id.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_appointment_id_fkey";
ALTER TABLE "invoices" ADD COLUMN "source_snapshot" JSONB;
CREATE TABLE "AppointmentBillingOperation" (
 "id" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, "actorRole" TEXT NOT NULL,
 "operationType" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "appointmentId" TEXT NOT NULL, "expectedRevision" INTEGER, "payload" JSONB NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PREPARING', "invoiceId" TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
 "snapshot" JSONB, "errorCode" TEXT, "errorStatus" INTEGER,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "terminalAt" TIMESTAMP(3), "finalizedAt" TIMESTAMP(3),
 "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
 CONSTRAINT "AppointmentBillingOperation_actorId_operationType_idempotencyKey_key" UNIQUE ("actorId","operationType","idempotencyKey"),
 CHECK ("state" IN ('PREPARING','COMMITTED','ABORTED')),
 CHECK ("actorRole" IN ('owner','admin','staff','doctor')),
 CHECK ("operationType" IN ('invoice.create','invoice.checkout')),
 CHECK ("expectedRevision" IS NULL OR "expectedRevision" >= 0),
 CHECK (("state" = 'COMMITTED' AND "invoiceId" IS NOT NULL AND "snapshot" IS NOT NULL) OR ("state" <> 'COMMITTED' AND "invoiceId" IS NULL))
);
CREATE UNIQUE INDEX "AppointmentBillingOperation_active_source_key" ON "AppointmentBillingOperation" ("appointmentId") WHERE state='PREPARING';
CREATE INDEX "AppointmentBillingOperation_state_nextAttemptAt_leaseUntil_idx" ON "AppointmentBillingOperation" (state,"nextAttemptAt","leaseUntil");
