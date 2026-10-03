-- Ordered, scoped reads used by paginated collections.
CREATE INDEX "owners_page_idx" ON "users" ("role", "full_name", "id");
CREATE INDEX "pets_page_idx" ON "pets" ("created_at", "id");
CREATE INDEX "pets_owner_page_idx" ON "pets" ("owner_id", "created_at", "id");
CREATE INDEX "appointments_page_idx" ON "appointments" ("status", "appointment_date" DESC, "appointment_time" DESC, "id" DESC);
CREATE INDEX "appointments_owner_page_idx" ON "appointments" ("owner_id", "status", "appointment_date" DESC, "appointment_time" DESC, "id" DESC);
CREATE INDEX "medical_records_owner_page_idx" ON "medical_records" ("owner_id", "visit_date", "id");
CREATE INDEX "medical_records_page_idx" ON "medical_records" ("visit_date", "id");
CREATE INDEX "medical_images_pet_page_idx" ON "medical_images" ("pet_id", "created_at", "id");
CREATE INDEX "hotel_bookings_page_idx" ON "hotel_bookings" ("status", "created_at" DESC, "id" DESC);
CREATE INDEX "hotel_bookings_owner_page_idx" ON "hotel_bookings" ("owner_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "care_notes_page_idx" ON "daily_care_notes" ("booking_id", "note_date", "id");
CREATE INDEX "notifications_role_page_idx" ON "notifications" ("recipient_role", "created_at", "id");
CREATE INDEX "notifications_owner_page_idx" ON "notifications" ("recipient_owner_id", "created_at", "id");
CREATE INDEX "invoices_page_idx" ON "invoices" ("issued_at", "id");
CREATE INDEX "invoices_owner_page_idx" ON "invoices" ("owner_id", "issued_at", "id");
