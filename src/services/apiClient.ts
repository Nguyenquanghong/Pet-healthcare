/**
 * Universal HTTP API Client for NIPOPETO.
 *
 * Development default: http://localhost:5000/api
 * Production default: /api
 * Override with: VITE_API_BASE_URL
 */

import { ApiError, ApiErrorCode, httpStatusToErrorCode } from "../utils/apiError";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:5000/api" : "/api")).replace(
  /\/$/,
  "",
);

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
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
      throw new ApiError(code, response.status, data?.error || "Backend request failed.", data);
    }

    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      ApiErrorCode.SERVER_ERROR,
      500,
      "Cannot connect to the backend server. Please check VITE_API_BASE_URL and network connectivity.",
      error,
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
