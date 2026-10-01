import type { UserAccount } from "./auth.js";

export type CounterOwnerData = { fullName: string; phone: string; email: string | null; address: string | null };
export interface OwnerRepository {
  findByContact(phone: string, email: string | null): Promise<{ id: string } | null>;
  createCounterOwner(data: CounterOwnerData): Promise<UserAccount>;
}
