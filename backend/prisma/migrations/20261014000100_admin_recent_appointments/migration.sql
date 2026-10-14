CREATE INDEX "appointments_admin_recent_idx" ON "appointments" ("status", "created_at" DESC, "id" DESC);
