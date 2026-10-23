import type { PrismaClient } from "@prisma/client";
import { bookingLifecycles } from "@nipopeto/contracts";
import { pendingExpiresAt } from "../../domain/hotelPendingExpiry.js";
import type { ExpiryBounds, HotelPendingExpiryStore } from "../../application/ports/hotelPendingExpiry.js";
import { writeNotification } from "./notificationOutbox.js";

// P01: expiry is a system move of the lifecycle table.
const expiry = bookingLifecycles.hotel.system["pending-expired"];

export class PrismaHotelPendingExpiryStore implements HotelPendingExpiryStore {
  constructor(private readonly client: PrismaClient) {}

  async duePending(bounds: ExpiryBounds, limit: number) {
    const rows = await this.client.hotelBooking.findMany({
      where: { status: { in: [...expiry.from] }, OR: [{ createdAt: { lte: bounds.createdBefore } }, { checkIn: { lte: bounds.checkInOnOrBefore } }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit, select: { id: true },
    });
    return rows.map(row => row.id);
  }

  expire(id: string, now: Date) {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;
      const booking = await tx.hotelBooking.findUnique({ where: { id } });
      // Staff may have confirmed or cancelled it since the scan.
      if (!booking || !(expiry.from as readonly string[]).includes(booking.status) || pendingExpiresAt(booking.createdAt, booking.checkIn) > now) return false;
      const saved = await tx.hotelBooking.update({ where: { id }, data: { status: expiry.to, statusRevision: { increment: 1 } } });
      await tx.bookingStatusEvent.create({ data: { kind: "hotel", bookingId: id, revision: saved.statusRevision, action: "expired", fromStatus: booking.status, toStatus: expiry.to,
        actorId: "system", actorName: "Hệ thống", actorRole: "system", reason: "Chưa được xác nhận trong 48 giờ hoặc trước 12:00 ngày nhận phòng." } });
      await writeNotification(tx, { recipientOwnerId: booking.ownerId, recipientRole: "owner", type: "booking_status_updated", title: "Yêu cầu đặt phòng đã hết hạn",
        message: "Yêu cầu lưu trú chưa được xác nhận kịp nên đã tự hủy và trả phòng. Bạn có thể đặt lại.", relatedPetId: booking.petId, relatedBookingId: id, actionUrl: "/owner/hotel-booking" });
      return true;
    });
  }
}
