import { allows, type Permission } from './permissions.js';

// P01: the booking lifecycle as data (a table-driven state machine). This is the
// one place that says which status may follow which, who may move it and which
// linked data blocks the move. Services still enforce it inside their transaction
// (row lock, guards, status events). tools/phase2/check-architecture-rules.mjs
// rejects hand-written transition tables and SQL "occupying" sets that drift.
export const bookingKinds = ['appointment', 'hotel'] as const;
export type BookingKind = typeof bookingKinds[number];

// Named guards over data the table cannot see; each service implements the ones
// its kinds use and refuses to start if the table names one it does not know.
export const lifecycleGuards = ['no-medical-record', 'no-active-invoice', 'no-care-note', 'final-invoice-paid'] as const;
export type LifecycleGuard = typeof lifecycleGuards[number];
export type TransitionRule = { readonly to: string; readonly permission: Permission; readonly guards: readonly LifecycleGuard[] };
export type OwnerStep = { readonly from: readonly string[]; readonly to: string; readonly guards: readonly LifecycleGuard[] };
export type Lifecycle = {
  readonly statuses: readonly string[];
  readonly initial: string;
  // Statuses that still hold the slot or room (the SQL predicates must match).
  readonly occupying: readonly string[];
  // PATCH status by staff.
  readonly manual: { readonly [from: string]: readonly TransitionRule[] };
  // Moves made by another use case or by the system, never by PATCH status. A use case
  // an actor starts names its permission; the system's own moves have none.
  readonly system: { readonly [name: string]: { readonly from: readonly string[]; readonly to: string; readonly permission?: Permission } };
  readonly undo: { readonly [from: string]: TransitionRule };
  readonly cancel: OwnerStep;
  readonly reschedule: OwnerStep | null;
};

const appointmentLinked = ['no-medical-record', 'no-active-invoice'] as const;
const hotelLinked = ['no-medical-record', 'no-active-invoice', 'no-care-note'] as const;
const manage = (to: string, guards: readonly LifecycleGuard[]) => ({ to, permission: 'booking.manage', guards }) as const;

export const bookingLifecycles = {
  appointment: {
    statuses: ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'],
    initial: 'pending',
    occupying: ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed'],
    manual: {
      pending: [manage('confirmed', appointmentLinked), manage('cancelled', appointmentLinked)],
      confirmed: [manage('checked_in', appointmentLinked), manage('no_show', appointmentLinked), manage('cancelled', appointmentLinked)],
      checked_in: [manage('in_progress', appointmentLinked)],
      in_progress: [manage('completed', appointmentLinked)],
    },
    // Saving the visit's medical record completes it.
    system: { 'medical-completed': { from: ['checked_in', 'in_progress'], to: 'completed', permission: 'medical-record.write' } },
    undo: {
      checked_in: manage('confirmed', appointmentLinked),
      completed: { to: 'in_progress', permission: 'booking.reopen', guards: appointmentLinked },
    },
    cancel: { from: ['pending', 'confirmed'], to: 'cancelled', guards: appointmentLinked },
    reschedule: { from: ['pending', 'confirmed'], to: 'pending', guards: appointmentLinked },
  },
  hotel: {
    statuses: ['pending', 'confirmed', 'in_stay', 'checked_out', 'cancelled', 'rejected'],
    initial: 'pending',
    occupying: ['pending', 'confirmed', 'in_stay'],
    manual: {
      pending: [manage('confirmed', hotelLinked), manage('rejected', hotelLinked), manage('cancelled', hotelLinked)],
      confirmed: [manage('in_stay', hotelLinked), manage('cancelled', hotelLinked)],
      // Handing the pet back needs the final invoice paid: that invoice and the stay's care notes are expected.
      in_stay: [manage('checked_out', ['final-invoice-paid', 'no-medical-record'])],
    },
    system: { 'pending-expired': { from: ['pending'], to: 'cancelled' } },
    undo: {
      in_stay: manage('confirmed', hotelLinked),
      // Reopening a finished stay keeps its paid invoice and care notes.
      checked_out: { to: 'in_stay', permission: 'booking.reopen', guards: ['no-medical-record'] },
    },
    cancel: { from: ['pending', 'confirmed'], to: 'cancelled', guards: hotelLinked },
    reschedule: null,
  },
} as const satisfies Record<BookingKind, Lifecycle>;

// Wording used inside status notifications ("Trạng thái lịch đặt: chờ xác nhận → đã xác nhận.").
export const bookingStatusLabels = {
  pending: 'chờ xác nhận', confirmed: 'đã xác nhận', checked_in: 'đã nhận thú cưng', in_progress: 'đang thực hiện',
  completed: 'hoàn thành dịch vụ', in_stay: 'đang lưu trú', checked_out: 'đã trả thú cưng', cancelled: 'đã hủy',
  rejected: 'đã từ chối', no_show: 'vắng mặt',
} as const satisfies Record<string, string>;

const lifecycleOf = (kind: BookingKind): Lifecycle => bookingLifecycles[kind];
const own = <T>(table: { readonly [key: string]: T }, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
export function manualTransition(kind: BookingKind, from: string, to: string): TransitionRule | undefined {
  return own(lifecycleOf(kind).manual, from)?.find(rule => rule.to === to);
}
export function undoRule(kind: BookingKind, from: string): TransitionRule | undefined {
  return own(lifecycleOf(kind).undo, from);
}
export function cancelRule(kind: BookingKind): OwnerStep { return lifecycleOf(kind).cancel; }
export function rescheduleRule(kind: BookingKind): OwnerStep | null { return lifecycleOf(kind).reschedule; }
export function systemTransition(kind: BookingKind, name: string) { return own(lifecycleOf(kind).system, name); }
export function isOccupying(kind: BookingKind, status: string): boolean { return lifecycleOf(kind).occupying.includes(status); }
export function statusLabel(status: string): string { return own<string>(bookingStatusLabels, status) ?? status; }

// P01 step 6: what an actor may try on a booking, from the table and its permissions
// only. Guards over linked data (record, invoice, care note) are not evaluated here,
// so the server can still refuse with a 409 that says why. Owners cancel and
// reschedule their own bookings; staff cancel through a transition.
export type BookingAction =
  | { readonly kind: 'transition' | 'undo'; readonly to: string }
  | { readonly kind: 'step'; readonly name: string; readonly to: string }
  | { readonly kind: 'cancel' | 'reschedule' };
export function allowedActions(kind: BookingKind, status: string, role: unknown, ownsBooking: boolean): BookingAction[] {
  const lifecycle = lifecycleOf(kind), actions: BookingAction[] = [];
  for (const rule of own(lifecycle.manual, status) ?? []) if (allows(role, rule.permission)) actions.push({ kind: 'transition', to: rule.to });
  const undo = own(lifecycle.undo, status);
  if (undo && allows(role, undo.permission)) actions.push({ kind: 'undo', to: undo.to });
  for (const [name, step] of Object.entries(lifecycle.system))
    if (step.permission && step.from.includes(status) && allows(role, step.permission)) actions.push({ kind: 'step', name, to: step.to });
  if (ownsBooking && lifecycle.cancel.from.includes(status)) actions.push({ kind: 'cancel' });
  if (ownsBooking && lifecycle.reschedule?.from.includes(status)) actions.push({ kind: 'reschedule' });
  return actions;
}
