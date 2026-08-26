export type MedicalRecordType = "checkup" | "vaccination" | "prescription" | "lab_result" | "imaging" | "surgery" | "dental" | "other";

export type MedicalRecord = {
  id: string;
  petId: string;
  ownerId: string;
  appointmentId?: string;
  doctorId: string;
  type: MedicalRecordType;
  visitDate: string;
  title: string;
  chiefComplaint?: string;
  weightKg?: number;
  temperatureC?: number;
  heartRateBpm?: number;
  diagnosis: string;
  treatmentNotes: string;
  prescriptionIds?: string[];
  followUpDate?: string;
  visibleToOwner: boolean;
  createdAt: string;
};

export type Prescription = {
  id: string;
  petId: string;
  ownerId: string;
  medicalRecordId?: string;
  medicationName: string;
  dosage: string;
  frequency: string;
  startDate: string;
  endDate?: string;
  instructions?: string;
  status: "active" | "expired" | "completed" | "cancelled" | "refill_requested";
  prescribedBy: string;
};