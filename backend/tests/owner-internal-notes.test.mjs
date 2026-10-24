import assert from "node:assert/strict";
import test from "node:test";
import { appointmentDto, hotelBookingDto, medicalRecordDto } from "../dist/src/lib/serialize.js";

test("owner projections exclude staff notes while staff projections retain them", () => {
  const date = new Date("2038-01-01T00:00:00.000Z");
  const appointment = { internalNote: "STAFF_APPOINTMENT_SECRET", appointmentDate: date, appointmentTime: "10:00" };
  const hotel = { internalNote: "STAFF_HOTEL_SECRET", checkIn: date, checkOut: date, totalAmount: 350000, dailyCareNotes: [] };
  const medical = { internalNote: "STAFF_MEDICAL_SECRET", visitDate: date, followUpDate: null, weightKg: null, temperatureC: null };
  // Bookings are projected for a viewer (P01 allowedActions); medical records for an owner flag.
  const owner = { role: "owner", sub: "o" }, staff = { role: "staff", sub: "s" };
  for (const [project, row, ownerView, staffView] of [[appointmentDto, appointment, owner, staff], [hotelBookingDto, hotel, owner, staff], [medicalRecordDto, medical, true, false]]) {
    assert.equal(Object.hasOwn(project(row, ownerView), "internalNote"), false);
    assert.equal(project(row, staffView).internalNote, row.internalNote);
  }
});
