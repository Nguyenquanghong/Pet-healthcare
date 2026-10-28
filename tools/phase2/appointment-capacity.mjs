// P10: the long-lived test databases keep the bookings of every earlier run, so a
// suite that does not test slot capacity lifts it; otherwise yesterday's runs would
// fill today's slots. A capacity test sets its own value on a date of its own and
// lifts it again afterwards (as the AQ-10 room capacity fixture does).
export async function liftAppointmentCapacity(clinic, capacity = 1000) {
  await clinic.appointmentResourceGroup.updateMany({ data: { capacity } });
  await clinic.appointmentSlotUsage.updateMany({ where: { capacity: { lt: capacity } }, data: { capacity } });
  // A fixture slot every run reuses (billing: 2026-10-12 10:00) outgrows even the lifted capacity
  // after about 30 runs and then fails with APPOINTMENT_SLOT_FULL; keep a slot within a tenth of the
  // lifted capacity of full `capacity` places short of full.
  const headroom = Math.ceil(capacity / 10);
  await clinic.$executeRaw`UPDATE appointment_slot_usage SET capacity = booked + ${capacity} WHERE booked >= capacity - ${headroom}`;
}
