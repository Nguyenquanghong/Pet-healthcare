/**
 * authService — Authentication Service Layer
 *
 * Hiện tại: gọi mock store trực tiếp qua useAppStore().
 *
 * Khi swap sang backend thật:
 *   - loginOwner: POST /api/auth/owner/login  { phone, password }
 *     Response: { token: string; owner: Owner }
 *   - loginAdmin: POST /api/auth/admin/login  { username, password }
 *     Response: { token: string; role: "admin" }
 *   - registerOwner: POST /api/auth/owner/register  { fullName, phone, email, address }
 *     Response: { token: string; owner: Owner }
 *   - Lưu token vào localStorage/cookie, đính kèm vào mọi request tiếp theo
 *     qua header `Authorization: Bearer <token>`.
 */

import type { LoginAdminDTO, LoginOwnerDTO, RegisterOwnerDTO } from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

/**
 * Xác thực owner theo số điện thoại.
 *
 * @throws {ApiError} UNAUTHORIZED nếu số điện thoại không tồn tại.
 *
 * TODO Backend: POST /api/auth/owner/login
 */
export async function loginOwner(
  dto: LoginOwnerDTO,
  storeFn: (phone: string) => boolean,
): Promise<void> {
  const success = storeFn(dto.phone);
  if (!success) {
    throw new ApiError(
      ApiErrorCode.UNAUTHORIZED,
      401,
      "Số điện thoại không tồn tại hoặc chưa đăng ký tài khoản.",
    );
  }
}

/**
 * Xác thực admin.
 *
 * @throws {ApiError} UNAUTHORIZED nếu sai username/password.
 *
 * TODO Backend: POST /api/auth/admin/login
 */
export async function loginAdmin(
  dto: LoginAdminDTO,
  storeFn: (username: string, password: string) => boolean,
): Promise<void> {
  const success = storeFn(dto.username, dto.password);
  if (!success) {
    throw new ApiError(
      ApiErrorCode.UNAUTHORIZED,
      401,
      "Tên đăng nhập hoặc mật khẩu không đúng.",
    );
  }
}

/**
 * Đăng ký chủ nuôi mới.
 *
 * TODO Backend: POST /api/auth/owner/register
 */
export async function registerOwner(
  dto: RegisterOwnerDTO,
  storeFn: (input: RegisterOwnerDTO) => void,
): Promise<void> {
  storeFn(dto);
}
