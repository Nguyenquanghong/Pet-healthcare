import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import { calendarDate } from "../../domain/validation.js";
import type { ListsRepository, ListQuery, ListResource } from "../ports/lists.js";

const statuses: Partial<Record<ListResource, readonly string[]>> = {
  appointments: ["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"],
  hotelBookings: ["pending", "confirmed", "in_stay", "checked_out", "cancelled", "rejected"],
  invoices: ["paid", "unpaid", "refunded"], notifications: ["sent", "read"],
};
const choices: Record<string, readonly string[]> = {
  species: ["dog", "cat", "rabbit", "other"], healthStatus: ["healthy", "stable", "vaccination_due", "under_treatment", "critical"],
  roomType: ["standard", "deluxe", "vip"], mode: ["unbilled"],
  statusGroup: ["pending", "completed", "cancelled"],
};
const allowed: Record<ListResource, string[]> = {
  owners: ["ownerId"], pets: ["ownerId", "species", "healthStatus"],
  appointments: ["ownerId", "petId", "status", "statusGroup", "category", "date", "mode"],
  hotelBookings: ["ownerId", "petId", "status", "roomType", "mode"],
  medicalRecords: ["ownerId", "petId"], medicalImages: ["petId"], dailyCareNotes: ["bookingId"],
  notifications: ["status", "category"], invoices: ["ownerId", "petId", "status", "bookingId"],
};
export function parseListQuery(resource: ListResource, raw: Record<string, unknown>): ListQuery {
  const integer = (key: string, fallback: number, max: number) => {
    if (raw[key] === undefined) return fallback;
    if (typeof raw[key] !== "string" || !/^[1-9]\d*$/.test(raw[key] as string)) throw new BusinessError(422, `Invalid ${key}.`);
    const value = Number(raw[key]);
    if (!Number.isSafeInteger(value) || value > max) throw new BusinessError(422, `${key} exceeds ${max}.`);
    return value;
  };
  const result: ListQuery = { page: integer("page", 1, 1_000_000), pageSize: integer("pageSize", 20, 100) };
  for (const key of ["q", "id", ...allowed[resource]]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || (raw[key] as string).length > (key === "q" ? 100 : 128)) throw new BusinessError(422, `Invalid ${key}.`);
    const value = (raw[key] as string).trim();
    if (!value || (value === "all" && key !== "q" && key !== "id")) continue;
    const options = key === "status" ? statuses[resource] : key === "category"
      ? resource === "appointments" ? ["medical", "spa"] : ["appointments", "hotel", "medical", "promo"] : choices[key];
    if (options && !options.includes(value)) throw new BusinessError(422, `Invalid ${key}.`);
    if (key === "date") calendarDate(value, "date");
    Object.assign(result, { [key]: value });
  }
  return result;
}

export class ListsService {
  constructor(private readonly repository: ListsRepository) {}
  async load(resource: ListResource, actor: Actor, raw: Record<string, unknown>) {
    if (resource === "owners" && actor.role === "owner") throw new BusinessError(403, "Owner directory is for staff only.");
    const query = parseListQuery(resource, raw);
    const scope = actor.role === "owner" ? { ownerId: actor.sub } : resource === "notifications" ? { recipientRole: "admin" } : {};
    const result = await this.repository.page(resource, scope, query);
    return { ...result, pagination: { page: query.page, pageSize: query.pageSize, total: result.total, totalPages: Math.ceil(result.total / query.pageSize) } };
  }
  async billingFigures(actor: Actor, rawMonth: unknown) {
    if (actor.role === "owner") throw new BusinessError(403, "Billing analytics is for staff only.");
    if (rawMonth !== undefined && (typeof rawMonth !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(rawMonth))) throw new BusinessError(422, "Invalid month.");
    return this.repository.billingFigures(rawMonth as string | undefined);
  }
  async calendar(actor: Actor, month: unknown, category: unknown) {
    if (typeof month !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw new BusinessError(422, "Invalid month.");
    if (category !== undefined && category !== "medical" && category !== "spa") throw new BusinessError(422, "Invalid category.");
    return this.repository.calendar(actor.role === "owner" ? { ownerId: actor.sub } : {}, month, category as string | undefined);
  }
}
