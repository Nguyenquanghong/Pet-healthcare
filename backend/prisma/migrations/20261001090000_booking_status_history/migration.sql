ALTER TABLE "appointments" ADD COLUMN "status_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "hotel_bookings" ADD COLUMN "status_revision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "booking_status_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('appointment', 'hotel')),
  "booking_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "from_status" TEXT NOT NULL,
  "to_status" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_name" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "reason" TEXT,
  "reverses_id" TEXT UNIQUE REFERENCES "booking_status_events"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("kind", "booking_id", "revision")
);
-- Keep audit records even if a source booking/user is later removed.
CREATE INDEX "booking_status_events_booking_idx" ON "booking_status_events"("kind", "booking_id", "created_at");
