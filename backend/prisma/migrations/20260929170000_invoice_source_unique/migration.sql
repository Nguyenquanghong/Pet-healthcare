-- Stop safely on duplicate source invoices; existing records require manual reconciliation.
-- NULL values remain allowed for legacy invoices without a source.
CREATE UNIQUE INDEX "invoices_appointment_id_key" ON "invoices"("appointment_id");
CREATE UNIQUE INDEX "invoices_hotel_booking_id_key" ON "invoices"("hotel_booking_id");
