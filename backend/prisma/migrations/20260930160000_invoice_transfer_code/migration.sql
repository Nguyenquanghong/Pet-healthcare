CREATE SEQUENCE "invoice_transfer_code_seq" MINVALUE 1 MAXVALUE 9999999999 NO CYCLE;
ALTER TABLE "invoices" ADD COLUMN "transfer_code" TEXT;
-- Preserve content already shown for existing bank transfers.
UPDATE "invoices" SET "transfer_code" = 'NIPO' || lpad(nextval('invoice_transfer_code_seq')::text, 10, '0')
WHERE "bank_transfer_details" IS NULL;
ALTER TABLE "invoices" ALTER COLUMN "transfer_code"
  SET DEFAULT ('NIPO' || lpad(nextval('invoice_transfer_code_seq')::text, 10, '0'));
CREATE UNIQUE INDEX "invoices_transfer_code_key" ON "invoices"("transfer_code");
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_transfer_code_format"
  CHECK ("transfer_code" IS NULL OR "transfer_code" ~ '^NIPO[0-9]{10}$');
