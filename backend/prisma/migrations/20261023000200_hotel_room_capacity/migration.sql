-- AQ-10: room capacity per type and night, enforced by the database.
-- hotel_room_nights counts the active stays (pending, confirmed, in_stay: the same
-- predicate as hotel_bookings_pet_active_stay_excl) per room type and night of the
-- half-open stay [check_in, check_out). Only the trigger below writes it, so every
-- writer (create, status change, undo, reopen, imports) keeps it exact, and the
-- CHECK rejects the write that would exceed capacity (SQLSTATE 23514, mapped to
-- 409 by hotelStayConflict.ts). Row locks on the night rows serialize concurrent
-- bookings of the last room.
CREATE TABLE "hotel_room_capacity" (
  "room_type" "RoomType" NOT NULL,
  "capacity" INTEGER NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_room_capacity_pkey" PRIMARY KEY ("room_type"),
  CONSTRAINT "hotel_room_capacity_range_check" CHECK ("capacity" BETWEEN 0 AND 1000)
);
-- Agent-chosen defaults (23/10), changed by an admin through PUT /api/hotel-capacity/{roomType}.
INSERT INTO "hotel_room_capacity" ("room_type", "capacity") VALUES ('standard', 10), ('deluxe', 5), ('vip', 2);

CREATE TABLE "hotel_room_nights" (
  "room_type" "RoomType" NOT NULL,
  "night" DATE NOT NULL,
  "booked" INTEGER NOT NULL DEFAULT 0,
  "capacity" INTEGER NOT NULL,
  CONSTRAINT "hotel_room_nights_pkey" PRIMARY KEY ("room_type", "night"),
  CONSTRAINT "hotel_room_nights_capacity_check" CHECK ("booked" >= 0 AND "booked" <= "capacity")
);
-- Existing active stays: a night already over the default keeps its count as its
-- capacity, so history never fails the CHECK; new bookings on it are refused.
INSERT INTO "hotel_room_nights" ("room_type", "night", "booked", "capacity")
SELECT b."room_type", d::date, count(*)::int, greatest(count(*)::int, c."capacity")
FROM "hotel_bookings" b
CROSS JOIN LATERAL generate_series(b."check_in", b."check_out" - 1, interval '1 day') d
JOIN "hotel_room_capacity" c ON c."room_type" = b."room_type"
WHERE b."status" IN ('pending', 'confirmed', 'in_stay')
GROUP BY b."room_type", d::date, c."capacity";

-- SET search_path FROM CURRENT: the trigger resolves its tables in the schema this
-- migration ran in, whatever search_path the writing session has (P7 imports).
CREATE FUNCTION hotel_room_nights_sync() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  was_active boolean := TG_OP <> 'INSERT' AND OLD."status" IN ('pending', 'confirmed', 'in_stay');
  is_active boolean := TG_OP <> 'DELETE' AND NEW."status" IN ('pending', 'confirmed', 'in_stay');
BEGIN
  IF TG_OP = 'UPDATE' AND was_active = is_active AND OLD."room_type" = NEW."room_type"
     AND OLD."check_in" = NEW."check_in" AND OLD."check_out" = NEW."check_out" THEN
    RETURN NULL;
  END IF;
  IF was_active THEN
    UPDATE "hotel_room_nights" SET "booked" = "booked" - 1
    WHERE "room_type" = OLD."room_type" AND "night" >= OLD."check_in" AND "night" < OLD."check_out";
  END IF;
  IF is_active THEN
    INSERT INTO "hotel_room_nights" ("room_type", "night", "booked", "capacity")
    SELECT NEW."room_type", d::date, 0, c."capacity"
    FROM generate_series(NEW."check_in", NEW."check_out" - 1, interval '1 day') d
    JOIN "hotel_room_capacity" c ON c."room_type" = NEW."room_type"
    ON CONFLICT ("room_type", "night") DO NOTHING;
    UPDATE "hotel_room_nights" SET "booked" = "booked" + 1
    WHERE "room_type" = NEW."room_type" AND "night" >= NEW."check_in" AND "night" < NEW."check_out";
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER hotel_room_nights_sync AFTER INSERT OR DELETE OR UPDATE OF "status", "room_type", "check_in", "check_out"
ON "hotel_bookings" FOR EACH ROW EXECUTE FUNCTION hotel_room_nights_sync();
