-- AQ-10: database backstop for "one active stay per pet at a time". The service
-- keeps its pet lock + interval check and 409; this constraint rejects any
-- writer that bypasses it (SQLSTATE 23P01, mapped to 409 by hotelStayConflict.ts).
-- Same predicate as hasOverlappingStay: active statuses, half-open [check_in, check_out).
-- btree_gist is a trusted extension (PostgreSQL 13+): the database owner can
-- create it without superuser. Existing overlapping active stays make this
-- migration fail and roll back; resolve them first, never by deleting history.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "hotel_bookings" ADD CONSTRAINT "hotel_bookings_pet_active_stay_excl"
  EXCLUDE USING gist ("pet_id" WITH =, daterange("check_in", "check_out", '[)') WITH &&)
  WHERE ("status" IN ('pending', 'confirmed', 'in_stay'));
