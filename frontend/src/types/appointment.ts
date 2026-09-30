export type AppointmentStatus = "pending" | "confirmed" | "checked_in" | "in_progress" | "completed" | "cancelled" | "no_show";
export type AppointmentType =
  | "general_checkup"
  | "vaccination"
  | "dental"
  | "dermatology"
  | "surgery"
  | "hotel_consultation"
  | "spa_bath"
  | "spa_grooming"
  | "spa_combo"
  | "other";
export type SpaAppointmentType = Extract<AppointmentType, "spa_bath" | "spa_grooming" | "spa_combo">;

export const SPA_APPOINTMENT_TYPES: SpaAppointmentType[] = ["spa_bath", "spa_grooming", "spa_combo"];
export const isSpaAppointmentType = (type: AppointmentType): type is SpaAppointmentType => SPA_APPOINTMENT_TYPES.includes(type as SpaAppointmentType);

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
  statusRevision: number;
  ownerNote?: string;
  internalNote?: string;
  createdBy: "owner" | "staff";
  createdAt: string;
  updatedAt: string;
};
