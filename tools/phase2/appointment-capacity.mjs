// P10: the long-lived test databases keep the bookings of every earlier run, so a
// suite that does not test slot capacity lifts it; otherwise yesterday's runs would
// fill today's slots. A capacity test sets its own value on a date of its own and
// lifts it again afterwards (as the AQ-10 room capacity fixture does).
export async function liftAppointmentCapacity(clinic, capacity = 1000) {
  await clinic.appointmentResourceGroup.updateMany({ data: { capacity } });
  await clinic.appointmentSlotUsage.updateMany({ where: { capacity: { lt: capacity } }, data: { capacity } });
}
