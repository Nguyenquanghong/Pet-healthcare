/**
 * ApiError — Chuẩn hóa Error Handling cho Backend Integration
 *
 * Khi kết nối với backend thật:
 *   - `fetch` / `axios` sẽ ném ra `ApiError` thay vì console.error.
 *   - UI có thể `catch (e)` và kiểm tra `e instanceof ApiError` để hiển thị
 *     thông báo lỗi phù hợp với từng mã lỗi.
 */

export enum ApiErrorCode {
  /** 401 — Chưa xác thực, cần đăng nhập lại */
  UNAUTHORIZED = "UNAUTHORIZED",

  /** 403 — Không có quyền thực hiện thao tác này */
  FORBIDDEN = "FORBIDDEN",

  /** 404 — Không tìm thấy tài nguyên */
  NOT_FOUND = "NOT_FOUND",

  /** 409 — Xung đột dữ liệu (VD: đặt trùng lịch) */
  CONFLICT = "CONFLICT",

  /** 422 — Dữ liệu đầu vào không hợp lệ */
  VALIDATION_ERROR = "VALIDATION_ERROR",

  /** 500 — Lỗi máy chủ nội bộ */
  SERVER_ERROR = "SERVER_ERROR",

  /** Lỗi không xác định */
  UNKNOWN = "UNKNOWN",
}

export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  [ApiErrorCode.UNAUTHORIZED]: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  [ApiErrorCode.FORBIDDEN]: "Bạn không có quyền thực hiện thao tác này.",
  [ApiErrorCode.NOT_FOUND]: "Không tìm thấy dữ liệu yêu cầu.",
  [ApiErrorCode.CONFLICT]: "Dữ liệu xung đột. Vui lòng kiểm tra lại (VD: đặt trùng lịch).",
  [ApiErrorCode.VALIDATION_ERROR]: "Dữ liệu nhập không hợp lệ. Vui lòng kiểm tra lại.",
  [ApiErrorCode.SERVER_ERROR]: "Máy chủ đang gặp sự cố. Vui lòng thử lại sau.",
  [ApiErrorCode.UNKNOWN]: "Đã có lỗi không xác định. Vui lòng thử lại.",
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    httpStatus: number,
    message?: string,
    details?: unknown,
  ) {
    super(message ?? API_ERROR_MESSAGES[code]);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;

    // Fix instanceof in TypeScript (needed when targeting ES5)
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** Lấy thông báo tiếng Việt thân thiện với người dùng */
  get userMessage(): string {
    return API_ERROR_MESSAGES[this.code];
  }

  /** Kiểm tra nhanh nếu là lỗi xác thực */
  get isAuthError(): boolean {
    return this.code === ApiErrorCode.UNAUTHORIZED || this.code === ApiErrorCode.FORBIDDEN;
  }
}

/**
 * Hàm tiện ích: chuyển đổi HTTP status code sang ApiErrorCode
 * Dùng khi xử lý response từ fetch/axios.
 */
export function httpStatusToErrorCode(status: number): ApiErrorCode {
  switch (status) {
    case 401: return ApiErrorCode.UNAUTHORIZED;
    case 403: return ApiErrorCode.FORBIDDEN;
    case 404: return ApiErrorCode.NOT_FOUND;
    case 409: return ApiErrorCode.CONFLICT;
    case 422: return ApiErrorCode.VALIDATION_ERROR;
    case 500:
    case 502:
    case 503: return ApiErrorCode.SERVER_ERROR;
    default: return ApiErrorCode.UNKNOWN;
  }
}
