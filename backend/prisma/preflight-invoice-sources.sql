-- Run before deploying the invoice-source uniqueness migration on an existing database.
-- Any returned row requires explicit reconciliation. This script does not change data.
SELECT appointment_id, COUNT(*) AS invoice_count
FROM invoices WHERE appointment_id IS NOT NULL
GROUP BY appointment_id HAVING COUNT(*) > 1;

SELECT hotel_booking_id, COUNT(*) AS invoice_count
FROM invoices WHERE hotel_booking_id IS NOT NULL
GROUP BY hotel_booking_id HAVING COUNT(*) > 1;
