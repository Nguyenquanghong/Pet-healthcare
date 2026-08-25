/**
 * Authentication service layer.
 *
 * The current app uses the local store, but these DTOs mirror the backend
 * contract for the API endpoints:
 *   - loginOwner: POST /api/auth/owner/login { email, password }
 *   - loginAdmin: POST /api/auth/admin/login { username, password }
 *   - registerOwner: POST /api/auth/owner/register { email, password, confirmPassword, fullName?, phone?, address? }
 */

import type { LoginAdminDTO, LoginOwnerDTO, RegisterOwnerDTO } from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

export async function loginOwner(
  dto: LoginOwnerDTO,
  storeFn: (email: string, password: string) => Promise<boolean>,
): Promise<void> {
  const success = await storeFn(dto.email, dto.password);
  if (!success) {
    throw new ApiError(ApiErrorCode.UNAUTHORIZED, 401, "The email or password is incorrect.");
  }
}

export async function loginAdmin(
  dto: LoginAdminDTO,
  storeFn: (username: string, password: string) => Promise<boolean>,
): Promise<void> {
  const success = await storeFn(dto.username, dto.password);
  if (!success) {
    throw new ApiError(ApiErrorCode.UNAUTHORIZED, 401, "The admin username or password is incorrect.");
  }
}

export async function registerOwner(
  dto: RegisterOwnerDTO,
  storeFn: (input: RegisterOwnerDTO) => Promise<void>,
): Promise<void> {
  await storeFn(dto);
}
