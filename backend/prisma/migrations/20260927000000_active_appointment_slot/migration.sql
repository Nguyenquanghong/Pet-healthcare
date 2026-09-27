-- Fail closed and identify conflicting rows. Existing appointments are never modified.
DO $$
DECLARE duplicates text;
BEGIN
  SELECT string_agg(
    format('pet=%s date=%s time=%s ids=%s', pet_id, appointment_date, appointment_time, appointment_ids),
    E'\n'
  ) INTO duplicates
  FROM (
    SELECT pet_id, appointment_date, appointment_time, array_agg(id ORDER BY id) AS appointment_ids
    FROM appointments
    WHERE status NOT IN ('cancelled', 'no_show')
    GROUP BY pet_id, appointment_date, appointment_time
    HAVING count(*) > 1
    ORDER BY appointment_date, appointment_time, pet_id
    LIMIT 20
  ) conflicts;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Active appointment slots contain duplicates; resolve these IDs before migration: %', duplicates;
  END IF;
  EXECUTE 'CREATE UNIQUE INDEX "appointments_active_pet_slot_key" ON "appointments" ("pet_id", "appointment_date", "appointment_time") WHERE "status" NOT IN (''cancelled'', ''no_show'')';
END $$;
