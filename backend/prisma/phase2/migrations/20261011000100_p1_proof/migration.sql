-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "BillingOperation" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofInvoice" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "sourceSnapshot" JSONB NOT NULL,

    CONSTRAINT "ProofInvoice_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "BillingOperation_actorId_idempotencyKey_key" ON "BillingOperation"("actorId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProofInvoice_operationId_key" ON "ProofInvoice"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProofInvoice_appointmentId_key" ON "ProofInvoice"("appointmentId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_nextAttemptAt_idx" ON "OutboxEvent"("publishedAt", "nextAttemptAt");


CREATE UNIQUE INDEX "BillingOperation_active_source" ON "BillingOperation" ("appointmentId") WHERE state = 'PREPARING';
ALTER TABLE "BillingOperation" ADD CONSTRAINT "operation_state_check" CHECK (state IN ('PREPARING','COMMITTED','ABORTED'));
ALTER TABLE "BillingOperation" ADD CONSTRAINT "amount_vnd_check" CHECK (amount >= 0);
ALTER TABLE "ProofInvoice" ADD CONSTRAINT "invoice_operation_fk" FOREIGN KEY ("operationId") REFERENCES "BillingOperation"(id);
