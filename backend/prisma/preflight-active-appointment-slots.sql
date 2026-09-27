-- Read-only preflight before applying 20260927000000_active_appointment_slot.
-- Any returned row must be resolved by the data owner; do not delete or cancel automatically.
SELECT pet_id, appointment_date, appointment_time, count(*) AS active_count,
       array_agg(id ORDER BY id) AS appointment_ids
FROM appointments
WHERE status NOT IN ('cancelled', 'no_show')
GROUP BY pet_id, appointment_date, appointment_time
HAVING count(*) > 1
ORDER BY appointment_date, appointment_time, pet_id;
