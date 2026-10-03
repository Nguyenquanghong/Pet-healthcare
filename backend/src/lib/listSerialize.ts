import type { ListData, ListResource } from "../application/ports/lists.js";
import { appointmentDto, careNoteDto, hotelBookingDto, medicalRecordDto, ownerDto, petDto } from "./serialize.js";
import type { InvoiceValue } from "../application/ports/invoices.js";

export const invoiceDto = (item: InvoiceValue) => ({ ...item, transferContent: item.transferCode || item.invoiceCode.replaceAll("-", ""), subtotal: Number(item.subtotal), taxAmount: Number(item.taxAmount), discountAmount: Number(item.discountAmount), totalAmount: Number(item.totalAmount),
  items: item.items?.map(line => ({ ...line, unitPrice: Number(line.unitPrice), amount: Number(line.amount) })) ?? [] });
export function listDataDto(data: ListData, owner: boolean) {
  return { owners: data.owners.map(ownerDto), pets: data.pets.map(petDto), appointments: data.appointments.map(item => appointmentDto(item, owner)),
    hotelBookings: data.hotelBookings.map(item => hotelBookingDto(item, owner)), medicalRecords: data.medicalRecords.map(item => medicalRecordDto(item, owner)),
    medicalImages: data.medicalImages, dailyCareNotes: data.dailyCareNotes.map(careNoteDto), notifications: data.notifications, invoices: data.invoices.map(invoiceDto) };
}
export function listResultDto(resource: ListResource, result: { data: ListData; pagination: unknown; counts: Record<string, number> }, owner: boolean) {
  const related = listDataDto(result.data, owner);
  const items = related[resource];
  return { items, pagination: result.pagination, counts: result.counts, related: { ...related, [resource]: [] } };
}
