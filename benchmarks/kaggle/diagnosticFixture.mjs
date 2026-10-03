// Synthetic historical service episodes, inserted in bounded batches outside load.
export async function prepareDiagnosticHistory(client, users, rows, adminId) {
  if (!Number.isInteger(rows) || rows < 1 || rows > 100000 || !users.length) {
    throw new Error("Diagnostic history needs 1..100000 rows and synthetic users.");
  }
  const pets = await client.pet.findMany({ where: { id: { in: users.map(user => user.petId) } }, select: { id: true, ownerId: true } });
  const owners = new Map(pets.map(pet => [pet.id, pet.ownerId]));
  if (users.some(user => !owners.has(user.petId))) throw new Error("Synthetic pet owner missing.");
  for (let start = 0; start < rows; start += 500) {
    const appointments = [], medical = [], bookings = [], notes = [], invoices = [], items = [], notifications = [];
    for (let i = start; i < Math.min(rows, start + 500); i++) {
      const petId = users[i % users.length].petId, ownerId = owners.get(petId);
      const day = new Date(Date.UTC(2020, 0, 1 + Math.floor(i / users.length)));
      const nextDay = new Date(day.getTime() + 86400000);
      const appt = `diag-appt-${i}`, booking = `diag-hotel-${i}`, invoice = `diag-invoice-${i}`;
      appointments.push({ id: appt, petId, ownerId, type: "general_checkup", serviceName: "Synthetic historical checkup",
        clinicName: "Synthetic clinic", appointmentDate: day, appointmentTime: "09:00", status: "completed", createdAt: day });
      medical.push({ id: `diag-medical-${i}`, petId, ownerId, appointmentId: appt, doctorName: "Synthetic doctor",
        visitDate: day, title: "Synthetic visit", diagnosis: "Synthetic normal result", treatment: "Synthetic follow-up", createdAt: day });
      bookings.push({ id: booking, petId, ownerId, checkIn: day, checkOut: nextDay, nights: 1, roomType: "standard",
        serviceKeys: [], totalAmount: 250000, status: "checked_out", createdAt: day });
      notes.push({ id: `diag-care-${i}`, bookingId: booking, noteDate: day, note: "Synthetic daily care",
        createdByStaffId: adminId, visibleToOwner: true, createdAt: day });
      invoices.push({ id: invoice, invoiceCode: `DIAG-${i}`, type: "hotel_booking", ownerId, petId, hotelBookingId: booking,
        subtotal: 250000, totalAmount: 250000, paymentStatus: "paid", paymentMethod: "cash", paymentChannel: "onsite",
        issuedAt: nextDay, paidAt: nextDay, createdAt: day });
      items.push({ id: `diag-item-${i}`, invoiceId: invoice, description: "Synthetic hotel stay", unitPrice: 250000, quantity: 1, amount: 250000 });
      for (const role of ["owner", "admin"]) notifications.push({ id: `diag-notice-${role}-${i}`,
        recipientOwnerId: role === "owner" ? ownerId : null, recipientRole: role, type: "booking_completed",
        title: "Synthetic history", message: "Synthetic completed stay", relatedBookingId: booking,
        status: "read", createdAt: nextDay, sentAt: nextDay });
    }
    // Dependency order matters. No single transaction spans the entire dataset.
    for (const [model, data] of [["appointment", appointments], ["medicalRecord", medical], ["hotelBooking", bookings],
      ["dailyCareNote", notes], ["invoice", invoices], ["invoiceItem", items], ["notification", notifications]]) {
      await client[model].createMany({ data });
    }
  }
  return { appointments: rows, medicalRecords: rows, hotelBookings: rows, dailyCareNotes: rows,
    invoices: rows, invoiceItems: rows, notifications: rows * 2, medicalImages: 0 };
}
