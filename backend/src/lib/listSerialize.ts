import type { ListData, ListResource } from "../application/ports/lists.js";
import { appointmentDto, careNoteDto, hotelBookingDto, invoiceDto, medicalRecordDto, ownerDto, petDto, type Viewer } from "./serialize.js";

export function listDataDto(data: ListData, viewer: Viewer) {
  const owner = viewer.role === "owner";
  return { owners: data.owners.map(ownerDto), pets: data.pets.map(petDto), appointments: data.appointments.map(item => appointmentDto(item, viewer)),
    hotelBookings: data.hotelBookings.map(item => hotelBookingDto(item, viewer)), medicalRecords: data.medicalRecords.map(item => medicalRecordDto(item, owner)),
    medicalImages: data.medicalImages, dailyCareNotes: data.dailyCareNotes.map(careNoteDto), notifications: data.notifications, invoices: data.invoices.map(invoiceDto) };
}
export function listResultDto(resource: ListResource, result: { data: ListData; pagination: unknown; counts: Record<string, number> }, viewer: Viewer) {
  const related = listDataDto(result.data, viewer);
  const items = related[resource];
  return { items, pagination: result.pagination, counts: result.counts, related: { ...related, [resource]: [] } };
}
