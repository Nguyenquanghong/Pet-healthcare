import type { Owner } from "./owner";
import type { Pet } from "./pet";
import type { Appointment } from "./appointment";
import type { HotelBooking, DailyCareNote } from "./booking";
import type { MedicalRecord } from "./medicalRecord";
import type { MedicalImage } from "./medicalImage";
import type { Notification } from "./notification";
import type { Invoice } from "./invoice";

export type PaginationInfo = { page: number; pageSize: number; total: number; totalPages: number };
export type RelatedData = { owners: Owner[]; pets: Pet[]; appointments: Appointment[]; hotelBookings: HotelBooking[];
  medicalRecords: MedicalRecord[]; medicalImages: MedicalImage[]; dailyCareNotes: DailyCareNote[]; notifications: Notification[]; invoices: Invoice[] };
export type ListPage<T> = { items: T[]; pagination: PaginationInfo; counts: Record<string, number>; related: RelatedData };
export const emptyRelated: RelatedData = { owners: [], pets: [], appointments: [], hotelBookings: [], medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [], invoices: [] };
