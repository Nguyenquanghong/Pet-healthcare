import { expiryBounds } from "../../domain/hotelPendingExpiry.js";
import type { HotelPendingExpiryStore } from "../ports/hotelPendingExpiry.js";

// AQ-10: frees the rooms of pending stays nobody confirmed in time (run by the Core worker).
export class HotelPendingExpiryService {
  constructor(private readonly store: HotelPendingExpiryStore) {}

  async expireDue(now = new Date(), limit = 50) {
    const due = await this.store.duePending(expiryBounds(now), limit);
    let expired = 0;
    for (const id of due) if (await this.store.expire(id, now)) expired++;
    return { due: due.length, expired };
  }
}
