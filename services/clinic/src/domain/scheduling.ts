import { BusinessError } from "./error.js";

// P10: scheduling rules as pure functions over policy data (appointment_resource_groups
// and appointment_type_policies). The database enforces what needs concurrency
// (capacity per slot, pet and doctor overlap); these rules give the early, explained
// 422s and list the slots a client may offer.
const SLOT_MINUTES = 30;
const VIETNAM_OFFSET = "+07:00"; // Vietnam has no daylight saving time.

export type SlotPolicy = {
  type: string; resourceGroup: string; durationMinutes: number; capacity: number;
  openTime: string | null; closeTime: string | null; stepMinutes: number | null; fixedSlots: readonly string[];
};

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const timeOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// Value Object: a half-open instant range [start, end).
class TimeRange {
  private constructor(readonly start: Date, readonly end: Date) {}
  static of(start: Date, minutes: number) {
    if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("INVALID_DURATION");
    return new TimeRange(start, new Date(start.getTime() + minutes * 60_000));
  }
  overlaps(other: TimeRange) { return this.start < other.end && other.start < this.end; }
  // The 30-minute slots the range touches, as the database counts them.
  slots(): Date[] {
    const step = SLOT_MINUTES * 60_000, first = Math.floor(this.start.getTime() / step) * step, out: Date[] = [];
    for (let at = first; at < this.end.getTime(); at += step) out.push(new Date(at));
    return out;
  }
}

export function vietnamInstant(date: string, time: string) { return new Date(`${date}T${time}:00${VIETNAM_OFFSET}`); }
export function slotRange(policy: SlotPolicy, date: string, time: string) { return TimeRange.of(vietnamInstant(date, time), policy.durationMinutes); }

// The start times a policy offers in a day: its fixed slots, or every step from
// opening until the last start that still ends by closing.
export function slotTimes(policy: SlotPolicy): string[] {
  if (policy.fixedSlots.length) return [...policy.fixedSlots];
  const open = minutesOf(policy.openTime!), close = minutesOf(policy.closeTime!), step = policy.stepMinutes!, out: string[] = [];
  for (let at = open; at + policy.durationMinutes <= close; at += step) out.push(timeOf(at));
  return out;
}

// Specification: the time is one the policy offers; otherwise a 422 that says why.
export function checkSlot(policy: SlotPolicy, time: string) {
  if (slotTimes(policy).includes(time)) return;
  if (policy.fixedSlots.length)
    throw new BusinessError(422, `Dịch vụ này chỉ nhận các khung giờ ${policy.fixedSlots.join(", ")}.`, "APPOINTMENT_SLOT_MISALIGNED");
  const at = minutesOf(time), open = minutesOf(policy.openTime!), close = minutesOf(policy.closeTime!);
  if (at < open || at + policy.durationMinutes > close)
    throw new BusinessError(422, `Phòng khám nhận lịch từ ${policy.openTime} đến ${policy.closeTime}; dịch vụ này cần ${policy.durationMinutes} phút.`, "APPOINTMENT_OUTSIDE_HOURS");
  throw new BusinessError(422, `Giờ hẹn phải theo bước ${policy.stepMinutes} phút tính từ ${policy.openTime}.`, "APPOINTMENT_SLOT_MISALIGNED");
}
