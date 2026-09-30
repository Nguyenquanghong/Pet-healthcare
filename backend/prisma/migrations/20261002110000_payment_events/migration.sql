CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_name" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "reason" TEXT,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_events_invoice_id_created_at_idx" ON "payment_events"("invoice_id", "created_at");
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
