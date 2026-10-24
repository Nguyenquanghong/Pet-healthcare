import type { ApiSchemas } from "../types/generated/api";

type BookingAction = ApiSchemas["BookingAction"];

// P01: the server lists what this viewer may try on a booking, from the lifecycle
// table and the viewer's permissions. A page shows a button only for a listed action,
// so it never offers a move the server refuses by rule. target is the status a
// transition or undo goes to, or the name of a step (medical-completed).
export function hasAction(booking: { allowedActions?: readonly BookingAction[] }, kind: BookingAction["kind"], target?: string) {
  return (booking.allowedActions ?? []).some(action => action.kind === kind
    && (target === undefined || (action.kind === "step" ? action.name === target : "to" in action && action.to === target)));
}
