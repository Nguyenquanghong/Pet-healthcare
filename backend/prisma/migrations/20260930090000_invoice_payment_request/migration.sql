ALTER TYPE "PaymentMethod" ADD VALUE 'vnpay';
ALTER TABLE "invoices" ADD COLUMN "payment_channel" TEXT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_channel_check" CHECK (payment_channel IS NULL OR payment_channel IN ('online', 'onsite'));
CREATE TABLE "payment_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "invoice_id" TEXT NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "transaction_no" TEXT UNIQUE,
  "response_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_attempt_status_check" CHECK (status IN ('pending', 'succeeded', 'failed', 'review'))
);
CREATE INDEX "payment_attempts_invoice_id_created_at_idx" ON "payment_attempts"("invoice_id", "created_at");
