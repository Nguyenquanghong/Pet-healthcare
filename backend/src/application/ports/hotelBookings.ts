export type HotelBookingValue = {
  id: string; petId: string; ownerId: string; checkIn: Date; checkOut: Date;
  nights: number; roomType: "standard" | "deluxe" | "vip"; serviceKeys: string[];
  totalAmount: number | { toString(): string }; status: "pending" | "confirmed" | "in_stay" | "checked_out" | "cancelled" | "rejected";
  ownerNote: string | null; internalNote: string | null; createdAt: Date; updatedAt: Date;
  dailyCareNotes?: Array<{ id: string }>;
  statusRevision: number;
};

export type CareNoteValue = {
  id: string; bookingId: string; noteDate: Date; eatingStatus: string; mood: string;
  note: string; visibleToOwner: boolean; createdByStaffId: string | null; createdAt: Date;
};

export type HotelBookingWrite = {
  petId: string; ownerId: string; checkIn: Date; checkOut: Date; nights: number;
  roomType: string; serviceKeys: string[]; totalAmount: number; ownerNote: string | null;
};

export type CareNoteWrite = {
  bookingId: string; noteDate: Date; eatingStatus: string; mood: string; note: string;
  visibleToOwner: boolean; createdByStaffId: string;
};

export interface HotelBookingRepository {
  list(ownerId?: string): Promise<HotelBookingValue[]>;
  findPet(id: string): Promise<{ id: string; ownerId: string; name: string } | null>;
  findWithPet(id: string): Promise<{ booking: HotelBookingValue; petName: string } | null>;
  findForCancel(id: string): Promise<HotelBookingValue | null>;
  create(data: HotelBookingWrite): Promise<HotelBookingValue>;
  updateStatus(id: string, status: string, internalNote: string | null): Promise<HotelBookingValue>;
  cancel(id: string, ownerNote: string | null): Promise<HotelBookingValue>;
  createCareNote(data: CareNoteWrite): Promise<CareNoteValue>;
}

export interface HotelNotificationWriter {
  create(draft: {
    recipientOwnerId?: string; recipientRole: string; type: string; title: string; message: string;
    actionUrl: string; relatedPetId: string; relatedBookingId: string;
  }): Promise<void>;
}

export interface HotelTransaction {
  bookings: HotelBookingRepository;
  notifications: HotelNotificationWriter;
}

export interface HotelUnitOfWork {
  run<T>(work: (repos: HotelTransaction) => Promise<T>): Promise<T>;
}

export interface HotelDependencies {
  bookings: HotelBookingRepository;
  unitOfWork: HotelUnitOfWork;
}
