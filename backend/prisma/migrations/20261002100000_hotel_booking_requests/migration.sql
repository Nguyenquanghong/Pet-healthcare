CREATE TABLE "hotel_booking_requests" (
    "actor_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hotel_booking_requests_pkey" PRIMARY KEY ("actor_id", "request_key")
);

CREATE INDEX "hotel_booking_requests_booking_id_idx" ON "hotel_booking_requests"("booking_id");
ALTER TABLE "hotel_booking_requests" ADD CONSTRAINT "hotel_booking_requests_booking_id_fkey"
  FOREIGN KEY ("booking_id") REFERENCES "hotel_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
