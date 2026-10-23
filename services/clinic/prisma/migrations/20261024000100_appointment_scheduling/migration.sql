BEGIN;
-- P10: an appointment occupies a time range and resources, enforced by the database.
--
-- Policy as data: each resource group has a capacity per 30-minute slot and either
-- opening hours with a step or a list of fixed start times; each appointment type
-- belongs to one group and has a duration. Values chosen by Kenn (23/10): exams
-- 08:00-17:30 every 30 minutes, 30 minutes (surgery 120), 2 per slot; Spa at
-- 09:00, 10:30, 13:30, 15:00, 16:30, 90 minutes, 2 per slot shared by the three
-- Spa types.
--
-- appointments.starts_at/ends_at are derived from date, time and type by a BEFORE
-- trigger, so every writer (service, P7 import, direct SQL) gets the same range.
-- An AFTER trigger keeps three tables exact for the occupying statuses (the P01
-- lifecycle table: every status but cancelled and no_show), on the 30-minute grid:
--   appointment_slot_usage    bookings per group and slot; CHECK booked <= capacity
--   appointment_pet_slots     one booking per pet and slot  (no overlap for a pet)
--   appointment_doctor_slots  one booking per doctor and slot (no overlap for a doctor)
-- Unique and CHECK violations become APPOINTMENT_PET_OVERLAP, APPOINTMENT_DOCTOR_BUSY
-- and APPOINTMENT_SLOT_FULL (mapped to 409 by appointmentSlotConflict.ts).
--
-- History: rows that exist before this migration (or are imported by P7) keep
-- schedule_checked = false. They count in usage, with a capacity that never makes
-- history fail the CHECK (as AQ-10 did), but not in the pet/doctor tables, because
-- older data may already overlap. Moving a booking to another time checks it.

CREATE TABLE appointment_resource_groups (
  resource_group text PRIMARY KEY,
  capacity integer NOT NULL,
  open_time text,
  close_time text,
  step_minutes integer,
  fixed_slots text[] NOT NULL DEFAULT '{}',
  CONSTRAINT appointment_resource_groups_capacity_check CHECK (capacity BETWEEN 0 AND 1000),
  CONSTRAINT appointment_resource_groups_hours_check CHECK (
    (cardinality(fixed_slots) > 0 AND open_time IS NULL AND close_time IS NULL AND step_minutes IS NULL)
    OR (cardinality(fixed_slots) = 0 AND open_time ~ '^([01][0-9]|2[0-3]):(00|30)$' AND close_time ~ '^([01][0-9]|2[0-3]):(00|30)$'
        AND open_time < close_time AND step_minutes IN (30, 60, 90, 120)))
);
INSERT INTO appointment_resource_groups (resource_group, capacity, open_time, close_time, step_minutes, fixed_slots) VALUES
  ('exam', 2, '08:00', '17:30', 30, '{}'),
  ('spa', 2, NULL, NULL, NULL, '{09:00,10:30,13:30,15:00,16:30}');

CREATE TABLE appointment_type_policies (
  type "AppointmentType" PRIMARY KEY,
  resource_group text NOT NULL REFERENCES appointment_resource_groups (resource_group),
  duration_minutes integer NOT NULL,
  CONSTRAINT appointment_type_policies_duration_check CHECK (duration_minutes BETWEEN 30 AND 480 AND duration_minutes % 30 = 0)
);
INSERT INTO appointment_type_policies (type, resource_group, duration_minutes) VALUES
  ('general_checkup', 'exam', 30), ('vaccination', 'exam', 30), ('dental', 'exam', 30), ('dermatology', 'exam', 30),
  ('hotel_consultation', 'exam', 30), ('other', 'exam', 30), ('surgery', 'exam', 120),
  ('spa_bath', 'spa', 90), ('spa_grooming', 'spa', 90), ('spa_combo', 'spa', 90);

CREATE TABLE appointment_slot_usage (
  resource_group text NOT NULL REFERENCES appointment_resource_groups (resource_group),
  slot_start timestamptz NOT NULL,
  booked integer NOT NULL DEFAULT 0,
  capacity integer NOT NULL,
  CONSTRAINT appointment_slot_usage_pkey PRIMARY KEY (resource_group, slot_start),
  CONSTRAINT appointment_slot_usage_capacity_check CHECK (booked >= 0 AND booked <= capacity)
);
CREATE TABLE appointment_pet_slots (
  pet_id text NOT NULL,
  slot_start timestamptz NOT NULL,
  appointment_id text NOT NULL,
  CONSTRAINT appointment_pet_slots_pkey PRIMARY KEY (pet_id, slot_start)
);
CREATE INDEX appointment_pet_slots_appointment_idx ON appointment_pet_slots (appointment_id);
CREATE TABLE appointment_doctor_slots (
  doctor_id text NOT NULL,
  slot_start timestamptz NOT NULL,
  appointment_id text NOT NULL,
  CONSTRAINT appointment_doctor_slots_pkey PRIMARY KEY (doctor_id, slot_start)
);
CREATE INDEX appointment_doctor_slots_appointment_idx ON appointment_doctor_slots (appointment_id);

-- The 30-minute slots a half-open range [starts, ends) touches.
CREATE FUNCTION appointment_slots(starts timestamptz, ends timestamptz) RETURNS SETOF timestamptz
LANGUAGE sql STABLE AS $$
  SELECT generate_series(date_bin('30 minutes', starts, TIMESTAMPTZ '2000-01-01 00:00+00'), ends - interval '1 microsecond', interval '30 minutes')
$$;

ALTER TABLE appointments
  ADD COLUMN starts_at timestamptz,
  ADD COLUMN ends_at timestamptz,
  ADD COLUMN schedule_checked boolean NOT NULL DEFAULT false;
UPDATE appointments a SET
  starts_at = (a.appointment_date + a.appointment_time::time) AT TIME ZONE 'Asia/Ho_Chi_Minh',
  ends_at = (a.appointment_date + a.appointment_time::time) AT TIME ZONE 'Asia/Ho_Chi_Minh' + make_interval(mins => p.duration_minutes)
FROM appointment_type_policies p WHERE p.type = a.type;
ALTER TABLE appointments
  ALTER COLUMN starts_at SET NOT NULL,
  ALTER COLUMN ends_at SET NOT NULL,
  ALTER COLUMN schedule_checked SET DEFAULT true,
  ADD CONSTRAINT appointments_range_valid CHECK (starts_at < ends_at);

-- SET search_path FROM CURRENT: the functions resolve their tables in the schema this
-- migration ran in, whatever search_path the writing session has (P7 imports).
CREATE FUNCTION appointment_schedule_times() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE minutes integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.appointment_date = OLD.appointment_date AND NEW.appointment_time = OLD.appointment_time AND NEW.type = OLD.type THEN
    RETURN NEW;
  END IF;
  SELECT duration_minutes INTO STRICT minutes FROM appointment_type_policies WHERE type = NEW.type;
  NEW.starts_at := (NEW.appointment_date + NEW.appointment_time::time) AT TIME ZONE 'Asia/Ho_Chi_Minh';
  NEW.ends_at := NEW.starts_at + make_interval(mins => minutes);
  -- A booking moved to another time is placed under the scheduling rules.
  IF TG_OP = 'UPDATE' THEN NEW.schedule_checked := true; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_schedule_times BEFORE INSERT OR UPDATE OF appointment_date, appointment_time, type
ON appointments FOR EACH ROW EXECUTE FUNCTION appointment_schedule_times();

-- SECURITY DEFINER: the runtime role reads the slot tables but never writes them.
CREATE FUNCTION appointment_schedule_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  was_active boolean := TG_OP <> 'INSERT' AND OLD.status NOT IN ('cancelled', 'no_show');
  is_active boolean := TG_OP <> 'DELETE' AND NEW.status NOT IN ('cancelled', 'no_show');
  grp text;
BEGIN
  IF TG_OP = 'UPDATE' AND was_active = is_active AND OLD.starts_at = NEW.starts_at AND OLD.ends_at = NEW.ends_at
     AND OLD.type = NEW.type AND OLD.pet_id = NEW.pet_id AND OLD.doctor_id IS NOT DISTINCT FROM NEW.doctor_id
     AND OLD.schedule_checked = NEW.schedule_checked THEN
    RETURN NULL;
  END IF;
  IF was_active THEN
    SELECT resource_group INTO STRICT grp FROM appointment_type_policies WHERE type = OLD.type;
    UPDATE appointment_slot_usage SET booked = booked - 1
    WHERE resource_group = grp AND slot_start IN (SELECT appointment_slots(OLD.starts_at, OLD.ends_at));
    DELETE FROM appointment_pet_slots WHERE appointment_id = OLD.id;
    DELETE FROM appointment_doctor_slots WHERE appointment_id = OLD.id;
  END IF;
  IF is_active THEN
    SELECT resource_group INTO STRICT grp FROM appointment_type_policies WHERE type = NEW.type;
    INSERT INTO appointment_slot_usage (resource_group, slot_start, booked, capacity)
    SELECT grp, s, 0, g.capacity FROM appointment_slots(NEW.starts_at, NEW.ends_at) s
    JOIN appointment_resource_groups g ON g.resource_group = grp
    ON CONFLICT (resource_group, slot_start) DO NOTHING;
    BEGIN
      UPDATE appointment_slot_usage SET booked = booked + 1
      WHERE resource_group = grp AND slot_start IN (SELECT appointment_slots(NEW.starts_at, NEW.ends_at));
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'APPOINTMENT_SLOT_FULL' USING ERRCODE = 'check_violation', CONSTRAINT = 'appointment_slot_usage_capacity_check';
    END;
    IF NEW.schedule_checked THEN
      BEGIN
        INSERT INTO appointment_pet_slots (pet_id, slot_start, appointment_id)
        SELECT NEW.pet_id, s, NEW.id FROM appointment_slots(NEW.starts_at, NEW.ends_at) s;
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'APPOINTMENT_PET_OVERLAP' USING ERRCODE = 'exclusion_violation';
      END;
      IF NEW.doctor_id IS NOT NULL THEN
        BEGIN
          INSERT INTO appointment_doctor_slots (doctor_id, slot_start, appointment_id)
          SELECT NEW.doctor_id, s, NEW.id FROM appointment_slots(NEW.starts_at, NEW.ends_at) s;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'APPOINTMENT_DOCTOR_BUSY' USING ERRCODE = 'exclusion_violation';
        END;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
-- appointment_date/time are listed because a BEFORE trigger's change to starts_at does not fire UPDATE OF starts_at.
CREATE TRIGGER appointment_schedule_sync AFTER INSERT OR DELETE OR UPDATE OF status, type, appointment_date, appointment_time, starts_at, ends_at, pet_id, doctor_id, schedule_checked
ON appointments FOR EACH ROW EXECUTE FUNCTION appointment_schedule_sync();

-- Recount every slot table from the appointments (the backfill below, and P7 after an
-- import made with appointment_schedule_sync disabled). A slot already over capacity
-- keeps its count as its capacity, so history never fails the CHECK.
CREATE FUNCTION appointment_schedule_rebuild() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM appointment_slot_usage;
  DELETE FROM appointment_pet_slots;
  DELETE FROM appointment_doctor_slots;
  INSERT INTO appointment_slot_usage (resource_group, slot_start, booked, capacity)
  SELECT p.resource_group, s, count(*)::int, greatest(count(*)::int, g.capacity)
  FROM appointments a
  JOIN appointment_type_policies p ON p.type = a.type
  JOIN appointment_resource_groups g ON g.resource_group = p.resource_group
  CROSS JOIN LATERAL appointment_slots(a.starts_at, a.ends_at) s
  WHERE a.status NOT IN ('cancelled', 'no_show')
  GROUP BY p.resource_group, s, g.capacity;
  INSERT INTO appointment_pet_slots (pet_id, slot_start, appointment_id)
  SELECT a.pet_id, s, a.id FROM appointments a CROSS JOIN LATERAL appointment_slots(a.starts_at, a.ends_at) s
  WHERE a.schedule_checked AND a.status NOT IN ('cancelled', 'no_show');
  INSERT INTO appointment_doctor_slots (doctor_id, slot_start, appointment_id)
  SELECT a.doctor_id, s, a.id FROM appointments a CROSS JOIN LATERAL appointment_slots(a.starts_at, a.ends_at) s
  WHERE a.schedule_checked AND a.doctor_id IS NOT NULL AND a.status NOT IN ('cancelled', 'no_show');
END;
$$;
SELECT appointment_schedule_rebuild();
COMMIT;
