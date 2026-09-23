import type { UserAccount } from "./auth.js";
import type { PetValue } from "./pets.js";
import type { AppointmentRecord } from "./appointments.js";
import type { MedicalRecordValue, MedicalImageValue } from "./medicalRecords.js";
import type { HotelBookingValue, CareNoteValue } from "./hotelBookings.js";
import type { NotificationValue } from "./notifications.js";

export type BootstrapData = {
  owners: Array<UserAccount & { pets: Array<{ id: string }> }>;
  pets: PetValue[];
  appointments: AppointmentRecord[];
  medicalRecords: MedicalRecordValue[];
  medicalImages: MedicalImageValue[];
  hotelBookings: HotelBookingValue[];
  dailyCareNotes: CareNoteValue[];
  notifications: NotificationValue[];
};

export interface BootstrapRepository {
  load(isAdmin: boolean, ownerId?: string): Promise<BootstrapData>;
}
