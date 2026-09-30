// Stable sorting preserves the existing date order within each status group.
export function compareBookingStatus(a: { status: string }, b: { status: string }): number {
  const rank = (status: string) => {
    if (["cancelled", "rejected", "no_show"].includes(status)) return 2;
    if (["completed", "checked_out"].includes(status)) return 1;
    return 0;
  };
  return rank(a.status) - rank(b.status);
}
