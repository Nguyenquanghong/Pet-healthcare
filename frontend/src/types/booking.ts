export type HotelRoomType = "standard" | "deluxe";
export type HotelBookingStatus = "pending" | "confirmed" | "in_stay" | "checked_out" | "rejected" | "cancelled";
export type HotelServiceKey = "grooming_spa" | "special_diet" | "video_call" | "daily_walk" | "medicine_support";

export type HotelBooking = {
  id: string;
  petId: string;
  ownerId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  roomType: HotelRoomType;
  serviceKeys: HotelServiceKey[];
  totalAmount: number;
  status: HotelBookingStatus;
  statusRevision: number;
  ownerNote?: string;
  internalNote?: string;
  dailyCareNoteIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type DailyCareNote = {
  id: string;
  bookingId: string;
  date: string;
  eatingStatus: "good" | "normal" | "poor";
  mood: "happy" | "calm" | "anxious" | "tired";
  note: string;
  visibleToOwner: boolean;
  createdByStaffId: string;
  createdAt: string;
};
