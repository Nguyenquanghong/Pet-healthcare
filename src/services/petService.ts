/**
 * petService — Service Layer cho quản lý thú cưng
 *
 * Hiện tại: bọc các hàm từ useAppStore() trả về Promise.
 *
 * Khi swap sang backend thật:
 *   - getPets:     GET    /api/pets?ownerId=...
 *   - createPet:   POST   /api/pets
 *   - updatePet:   PATCH  /api/pets/:id
 *   - deletePet:   DELETE /api/pets/:id  (chưa implement, để sẵn)
 */

import type { Pet } from "../types/pet";
import type { CreatePetDTO, UpdatePetDTO } from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

const SIMULATED_DELAY = 150;
const delay = <T>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), SIMULATED_DELAY));

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Lấy danh sách thú cưng của owner hiện tại từ store. */
export async function getPets(pets: Pet[]): Promise<Pet[]> {
  return delay(pets);
}

/** Lấy thú cưng theo ID. */
export async function getPetById(
  pets: Pet[],
  petId: string,
): Promise<Pet> {
  const pet = pets.find((p) => p.id === petId);
  if (!pet) {
    throw new ApiError(ApiErrorCode.NOT_FOUND, 404, "Không tìm thấy thú cưng.");
  }
  return delay(pet);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Tạo thú cưng mới.
 * TODO Backend: POST /api/pets
 */
export async function createPet(
  dto: CreatePetDTO,
  storeFn: (input: CreatePetDTO) => void,
): Promise<void> {
  if (!dto.name.trim()) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Tên thú cưng không được để trống.",
    );
  }
  storeFn(dto);
  return delay(undefined);
}

/**
 * Cập nhật thông tin thú cưng.
 * TODO Backend: PATCH /api/pets/:id
 */
export async function updatePet(
  petId: string,
  dto: UpdatePetDTO,
  storeFn: (petId: string, input: UpdatePetDTO) => void,
): Promise<void> {
  storeFn(petId, dto);
  return delay(undefined);
}
