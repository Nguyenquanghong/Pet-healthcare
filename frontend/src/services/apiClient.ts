import { ApiError, ApiErrorCode, httpStatusToErrorCode } from "../utils/apiError";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:5000/api" : "/api")).replace(/\/$/, "");
const TOKEN_KEY = "nipopeto_access_token";

export const authToken = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = authToken.get();
  const response = await fetch(`${API_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  }).catch((error) => {
    throw new ApiError(ApiErrorCode.SERVER_ERROR, 503, "Cannot connect to the backend server.", error);
  });

  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(httpStatusToErrorCode(response.status), response.status, data?.error || "Backend request failed.", data);
  }
  return data as T;
}

export const apiClient = {
  get: <T>(url: string, options: Pick<RequestInit, "signal"> = {}) => request<T>(url, { ...options, method: "GET" }),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>(url, { method: "POST", body: JSON.stringify(body), headers }),
  patch: <T>(url: string, body?: unknown) => request<T>(url, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};
