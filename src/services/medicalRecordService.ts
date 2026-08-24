/**
 * medicalRecordService — Service Layer cho Hồ sơ Bệnh án
 *
 * Hiện tại: bọc các hàm từ useAppStore() trả về Promise.
 *
 * Khi swap sang backend thật:
 *   - getRecords:    GET    /api/medical-records?ownerId=...&petId=...
 *   - createRecord:  POST   /api/medical-records
 *   - updateRecord:  PATCH  /api/medical-records/:id
 *   - deleteRecord:  DELETE /api/medical-records/:id
 */

import type { MedicalRecord } from "../types/medicalRecord";
import type { CreateMedicalRecordDTO, UpdateMedicalRecordDTO } from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

const SIMULATED_DELAY = 150;
const delay = <T>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), SIMULATED_DELAY));

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Lấy tất cả hồ sơ bệnh án từ store, có thể lọc theo petId. */
export async function getMedicalRecords(
  records: MedicalRecord[],
  filter?: { ownerId?: string; petId?: string },
): Promise<MedicalRecord[]> {
  let result = records;
  if (filter?.ownerId) result = result.filter((r) => r.ownerId === filter.ownerId);
  if (filter?.petId) result = result.filter((r) => r.petId === filter.petId);
  return delay(result);
}

/** Lấy bệnh án theo ID. */
export async function getMedicalRecordById(
  records: MedicalRecord[],
  recordId: string,
): Promise<MedicalRecord> {
  const record = records.find((r) => r.id === recordId);
  if (!record) {
    throw new ApiError(ApiErrorCode.NOT_FOUND, 404, "Không tìm thấy hồ sơ bệnh án.");
  }
  return delay(record);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Tạo hồ sơ bệnh án mới.
 * TODO Backend: POST /api/medical-records
 */
export async function createMedicalRecord(
  dto: CreateMedicalRecordDTO,
  storeFn: (input: CreateMedicalRecordDTO) => void,
): Promise<void> {
  if (!dto.title.trim() || !dto.visitDate || !dto.petId) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Vui lòng điền đủ thông tin tiêu đề, ngày khám và thú cưng.",
    );
  }
  storeFn(dto);
  return delay(undefined);
}

/**
 * Cập nhật hồ sơ bệnh án.
 * TODO Backend: PATCH /api/medical-records/:id
 */
export async function updateMedicalRecord(
  recordId: string,
  dto: UpdateMedicalRecordDTO,
  storeFn: (id: string, input: UpdateMedicalRecordDTO) => void,
): Promise<void> {
  storeFn(recordId, dto);
  return delay(undefined);
}

/**
 * Xóa hồ sơ bệnh án.
 * TODO Backend: DELETE /api/medical-records/:id
 */
export async function deleteMedicalRecord(
  recordId: string,
  storeFn: (id: string) => void,
): Promise<void> {
  storeFn(recordId);
  return delay(undefined);
}
