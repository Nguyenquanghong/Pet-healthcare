ALTER TABLE "invoices"
  DROP CONSTRAINT "invoice_channel_check",
  ADD COLUMN "bank_transfer_details" JSONB,
  ADD COLUMN "transfer_review_status" TEXT,
  ADD COLUMN "transfer_reported_at" TIMESTAMP(3),
  ADD COLUMN "transfer_reference" TEXT,
  ADD COLUMN "transfer_review_note" TEXT,
  ADD CONSTRAINT "invoice_channel_check" CHECK (payment_channel IS NULL OR payment_channel IN ('online', 'onsite', 'bank_transfer')),
  ADD CONSTRAINT "invoice_transfer_review_check" CHECK (transfer_review_status IS NULL OR transfer_review_status IN ('pending', 'rejected', 'confirmed'));
