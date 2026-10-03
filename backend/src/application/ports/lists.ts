import type { BootstrapData } from "./bootstrap.js";
import type { InvoiceValue } from "./invoices.js";

export type ListData = BootstrapData & { invoices: InvoiceValue[] };
export const listResources = ["owners", "pets", "appointments", "hotelBookings", "medicalRecords", "medicalImages", "dailyCareNotes", "notifications", "invoices"] as const;
export type ListResource = typeof listResources[number];
export type ListQuery = {
  page: number; pageSize: number; q?: string; ownerId?: string; petId?: string; id?: string;
  status?: string; species?: string; healthStatus?: string; roomType?: string;
  category?: string; date?: string; bookingId?: string; mode?: string; month?: string; statusGroup?: string;
};
export type ListScope = { ownerId?: string; recipientRole?: string };
export type ListResult = { data: ListData; total: number; counts: Record<string, number> };
export type BillingFigures = { received: number; hotel: number; appointment: number; outstanding: number; paidCount: number; unpaidCount: number };
export interface ListsRepository {
  page(resource: ListResource, scope: ListScope, query: ListQuery): Promise<ListResult>;
  billingFigures(month?: string): Promise<BillingFigures>;
  calendar(scope: ListScope, month: string, category?: string): Promise<Record<string, number>>;
}
