import { Router, Request, Response } from "express";
import { db } from "../db";

export const hotelBookingsRouter = Router();

// GET /api/hotel-bookings
hotelBookingsRouter.get("/", (req: Request, res: Response) => {
  const { ownerId, petId, status } = req.query;
  let list = db.get().hotelBookings;
  if (ownerId) list = list.filter((b) => b.ownerId === String(ownerId));
  if (petId) list = list.filter((b) => b.petId === String(petId));
  if (status && status !== "all") list = list.filter((b) => b.status === String(status));
  return res.json(list);
});

// POST /api/hotel-bookings
hotelBookingsRouter.post("/", (req: Request, res: Response) => {
  const { petId, ownerId, checkIn, checkOut, roomType, serviceKeys, ownerNote } = req.body;
  if (!petId || !checkIn || !checkOut) {
    return res.status(422).json({ error: "Thông tin thú cưng và ngày lưu trú là bắt buộc" });
  }

  const d1 = new Date(checkIn).getTime();
  const d2 = new Date(checkOut).getTime();
  const nights = Math.max(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)), 1);

  const roomRates = { standard: 3500, deluxe: 6000, vip: 10000 };
  const baseRate = roomRates[roomType as "standard" | "deluxe" | "vip"] || 3500;
  const totalAmount = baseRate * nights;

  const now = new Date().toISOString();
  const newBooking = {
    id: `booking_${Date.now()}`,
    petId,
    ownerId: ownerId || "owner_1",
    checkIn,
    checkOut,
    nights,
    roomType: roomType || "standard",
    serviceKeys: Array.isArray(serviceKeys) ? serviceKeys : [],
    totalAmount,
    status: "pending",
    ownerNote: ownerNote?.trim(),
    dailyCareNoteIds: [],
    createdAt: now,
    updatedAt: now,
  };

  db.update((draft) => {
    draft.hotelBookings.unshift(newBooking);
    draft.notifications.unshift({
      id: `noti_${Date.now()}`,
      recipientRole: "admin",
      type: "hotel_booking_created",
      title: "Hotel booking mới",
      message: `Đã có yêu cầu đặt phòng lưu trú ${nights} đêm từ ngày ${checkIn} đến ${checkOut}.`,
      status: "sent",
      actionUrl: "/admin/hotel-bookings",
      relatedBookingId: newBooking.id,
      relatedPetId: newBooking.petId,
      createdAt: now,
      sentAt: now,
    });
  });

  return res.status(201).json({ message: "Đặt phòng lưu trú thành công", booking: newBooking });
});

// PATCH /api/hotel-bookings/:id/status
hotelBookingsRouter.patch("/:id/status", (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, internalNote } = req.body;

  const idx = db.get().hotelBookings.findIndex((b) => b.id === id);
  if (idx === -1) return res.status(404).json({ error: "Không tìm thấy booking" });

  let updatedBooking: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.hotelBookings[idx] = {
      ...draft.hotelBookings[idx],
      status: status || draft.hotelBookings[idx].status,
      internalNote: internalNote !== undefined ? internalNote : draft.hotelBookings[idx].internalNote,
      updatedAt: now,
    };
    updatedBooking = draft.hotelBookings[idx];
  });

  return res.json({ message: "Cập nhật trạng thái booking thành công", booking: updatedBooking });
});

// POST /api/hotel-bookings/:id/care-notes
hotelBookingsRouter.post("/:id/care-notes", (req: Request, res: Response) => {
  const { id } = req.params;
  const { eatingStatus, mood, note, visibleToOwner } = req.body;
  if (!note?.trim()) {
    return res.status(422).json({ error: "Ghi chú chăm sóc không được để trống" });
  }

  const bookingIdx = db.get().hotelBookings.findIndex((b) => b.id === id);
  if (bookingIdx === -1) return res.status(404).json({ error: "Không tìm thấy booking" });

  const now = new Date().toISOString();
  const newCareNote = {
    id: `care_note_${Date.now()}`,
    bookingId: id,
    date: now.slice(0, 10),
    eatingStatus: eatingStatus || "normal",
    mood: mood || "calm",
    note: note.trim(),
    visibleToOwner: visibleToOwner !== undefined ? visibleToOwner : true,
    createdByStaffId: "staff_admin",
    createdAt: now,
  };

  db.update((draft) => {
    draft.dailyCareNotes.unshift(newCareNote);
    draft.hotelBookings[bookingIdx].dailyCareNoteIds.push(newCareNote.id);
    draft.hotelBookings[bookingIdx].updatedAt = now;
  });

  return res.status(201).json({ message: "Thêm nhật ký chăm sóc thành công", careNote: newCareNote });
});
