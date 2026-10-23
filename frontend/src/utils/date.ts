// The clinic keeps Vietnam's calendar (UTC+7, no daylight saving), like the backend's
// todayInVietnam: a device set to another time zone must not move default or minimum dates.
export const vietnamIsoDate = (instant = Date.now()) => new Date(instant + 7 * 3_600_000).toISOString().slice(0, 10);

export const todayIso = () => vietnamIsoDate();

export const addDaysIso = (days: number) => vietnamIsoDate(Date.now() + days * 86_400_000);

// Instants (issuedAt, paidAt, createdAt…) are shown on the clinic's clock too.
const VIETNAM_TIME = { timeZone: "Asia/Ho_Chi_Minh" } as const;
export const formatDate = (value: string) => new Date(value).toLocaleDateString("vi-VN", VIETNAM_TIME);
export const formatDateTime = (value: string) => new Date(value).toLocaleString("vi-VN", VIETNAM_TIME);

export const daysBetween = (start: string, end: string) => {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000));
};
