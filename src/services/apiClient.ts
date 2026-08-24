/**
 * apiClient — Universal HTTP API Client for NIPONETO
 *
 * Tự động gửi request đến Express Backend REST API (http://localhost:5000/api).
 * Nếu Backend chưa chạy hoặc gặp lỗi mạng, sẽ trả về lỗi ApiError rõ ràng
 * hoặc fallback về Local Mock Store.
 */

import { ApiError, ApiErrorCode, httpStatusToErrorCode } from "../utils/apiError";

const API_BASE_URL = "http://localhost:5000/api";

export async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const code = httpStatusToErrorCode(response.status);
      throw new ApiError(code, response.status, data?.error || "Lỗi giao tiếp máy chủ", data);
    }

    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Network failure (server is offline)
    throw new ApiError(
      ApiErrorCode.SERVER_ERROR,
      500,
      "Không thể kết nối đến Backend Server. Vui lòng kiểm tra lại kết nối mạng.",
      error
    );
  }
}

export const apiClient = {
  get: <T>(url: string, options?: RequestInit) => request<T>(url, { method: "GET", ...options }),
  post: <T>(url: string, body?: unknown, options?: RequestInit) =>
    request<T>(url, { method: "POST", body: JSON.stringify(body), ...options }),
  patch: <T>(url: string, body?: unknown, options?: RequestInit) =>
    request<T>(url, { method: "PATCH", body: JSON.stringify(body), ...options }),
  delete: <T>(url: string, options?: RequestInit) => request<T>(url, { method: "DELETE", ...options }),
};
