-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ProofAppointment" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "petId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ProofAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingReservation" (
    "operationId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "revisionAtPrepare" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'HELD',
    "invoiceId" TEXT,

    CONSTRAINT "BillingReservation_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_nextAttemptAt_idx" ON "OutboxEvent"("publishedAt", "nextAttemptAt");


CREATE UNIQUE INDEX "ProofAppointment_active_slot" ON "ProofAppointment" ("petId",date,time) WHERE status NOT IN ('cancelled','no_show');
CREATE UNIQUE INDEX "BillingReservation_active_source" ON "BillingReservation" ("appointmentId") WHERE state IN ('HELD','INVOICED');
ALTER TABLE "BillingReservation" ADD CONSTRAINT "reservation_state_check" CHECK (state IN ('HELD','INVOICED','RELEASED'));
ALTER TABLE "BillingReservation" ADD CONSTRAINT "reservation_appointment_fk" FOREIGN KEY ("appointmentId") REFERENCES "ProofAppointment"(id);
