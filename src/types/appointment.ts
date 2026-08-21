export type AppointmentStatus = "pending" | "confirmed" | "checked_in" | "in_progress" | "completed" | "cancelled" | "no_show";
export type AppointmentType = "general_checkup" | "vaccination" | "dental" | "dermatology" | "surgery" | "hotel_consultation" | "other";

export type Appointment = {
  id: string;
  petId: string;
  ownerId: string;
  doctorId?: string;
  type: AppointmentType;
  serviceName: string;
  clinicName: string;
  date: string;
  time: string;
  status: AppointmentStatus;
  ownerNote?: string;
  internalNote?: string;
  createdBy: "owner" | "staff";
  createdAt: string;
  updatedAt: string;
};