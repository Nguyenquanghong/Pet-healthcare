/**
 * Medical record service layer.
 *
 * Validate form input and await the app store's REST write and refresh result.
 * The read helpers below retain their local filtering behavior for callers.
 */

import type { MedicalRecord } from "../types/medicalRecord";
import type { CreateMedicalRecordDTO, UpdateMedicalRecordDTO } from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

const SIMULATED_DELAY = 150;
const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => window.setTimeout(() => resolve(value), SIMULATED_DELAY));

export async function getMedicalRecords(
  records: MedicalRecord[],
  filter?: { ownerId?: string; petId?: string },
): Promise<MedicalRecord[]> {
  let result = records;
  if (filter?.ownerId) result = result.filter((record) => record.ownerId === filter.ownerId);
  if (filter?.petId) result = result.filter((record) => record.petId === filter.petId);
  return delay(result);
}

export async function getMedicalRecordById(
  records: MedicalRecord[],
  recordId: string,
): Promise<MedicalRecord> {
  const record = records.find((item) => item.id === recordId);
  if (!record) {
    throw new ApiError(ApiErrorCode.NOT_FOUND, 404, "Medical record not found.");
  }
  return delay(record);
}

export async function createMedicalRecord(
  dto: CreateMedicalRecordDTO,
  storeFn: (input: CreateMedicalRecordDTO) => Promise<boolean>,
): Promise<boolean> {
  if (!dto.petId || !dto.title.trim() || !dto.visitDate || !dto.diagnosis?.trim() || !dto.treatment?.trim()) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Please complete the pet, title, visit date, diagnosis, and treatment fields.",
    );
  }

  return storeFn({
    ...dto,
    title: dto.title.trim(),
    symptoms: dto.symptoms?.trim(),
    diagnosis: dto.diagnosis.trim(),
    treatment: dto.treatment.trim(),
    medications: dto.medications?.trim(),
    vaccineName: dto.vaccineName?.trim(),
  });
}

export async function updateMedicalRecord(
  recordId: string,
  dto: UpdateMedicalRecordDTO,
  storeFn: (id: string, input: UpdateMedicalRecordDTO) => Promise<boolean>,
): Promise<boolean> {
  if (dto.title !== undefined && !dto.title.trim()) {
    throw new ApiError(ApiErrorCode.VALIDATION_ERROR, 422, "Title is required.");
  }
  if (dto.diagnosis !== undefined && !dto.diagnosis.trim()) {
    throw new ApiError(ApiErrorCode.VALIDATION_ERROR, 422, "Diagnosis is required.");
  }
  if (dto.treatment !== undefined && !dto.treatment.trim()) {
    throw new ApiError(ApiErrorCode.VALIDATION_ERROR, 422, "Treatment is required.");
  }

  // Keep null: it is how a cleared optional field reaches the server.
  const trim = (value: string | null | undefined) => (typeof value === "string" ? value.trim() : value);
  return storeFn(recordId, {
    ...dto,
    title: dto.title?.trim(),
    symptoms: trim(dto.symptoms),
    diagnosis: dto.diagnosis?.trim(),
    treatment: dto.treatment?.trim(),
    medications: trim(dto.medications),
    vaccineName: trim(dto.vaccineName),
  });
}

export async function deleteMedicalRecord(
  recordId: string,
  expectedRevision: number,
  storeFn: (id: string, expectedRevision: number) => Promise<boolean>,
): Promise<boolean> {
  if (!recordId) {
    throw new ApiError(ApiErrorCode.VALIDATION_ERROR, 422, "Medical record ID is required.");
  }
  return storeFn(recordId, expectedRevision);
}
