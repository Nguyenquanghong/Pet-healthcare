import type { ApiSchemas } from "./generated/api";

// AQ-07: generated from the OpenAPI contract (types/generated/api.ts).
export type Appointment = ApiSchemas["Appointment"];
export type AppointmentStatus = Appointment["status"];
export type AppointmentType = Appointment["type"];
export type SpaAppointmentType = Extract<AppointmentType, "spa_bath" | "spa_grooming" | "spa_combo">;
export const SPA_APPOINTMENT_TYPES: SpaAppointmentType[] = ["spa_bath", "spa_grooming", "spa_combo"];
export const isSpaAppointmentType = (type: AppointmentType): type is SpaAppointmentType => SPA_APPOINTMENT_TYPES.includes(type as SpaAppointmentType);
