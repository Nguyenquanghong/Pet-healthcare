export const roles = ["owner", "doctor", "staff", "admin"] as const;
export type Role = (typeof roles)[number];
export type Actor = { sub: string; role: Role };
