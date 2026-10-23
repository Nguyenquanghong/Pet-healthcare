import { ApiError, ApiErrorCode, httpStatusToErrorCode } from "../utils/apiError";
import {clinicReadState} from './clinicReadState';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? "http://localhost:5000/api" : "/api")).replace(/\/$/, "");
const TOKEN_KEY = "nipopeto_access_token";

export const authToken = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => {sessionStorage.setItem(TOKEN_KEY, token);clinicReadState.sync(token);},
  clear: () => {sessionStorage.removeItem(TOKEN_KEY);clinicReadState.sync(null);},
};

export async function request<T>(endpoint: string, options: RequestInit = {},retried=false): Promise<T> {
  const token = authToken.get();
  clinicReadState.sync(token);
  const epoch=clinicReadState.epoch(),sessionSignal=clinicReadState.signal();
  const method=options.method??'GET';
  const clinicRead=method==='GET'&&/^\/appointments(?:\?|$|\/calendar(?:\?|$))/.test(endpoint);
  const clinicWrite=method!=='GET'&&(/^\/appointments(?:\/|$)/.test(endpoint)&&!endpoint.endsWith('/reminder')||endpoint==='/medical-records'&&method==='POST');
  const response = await fetch(`${API_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`, {
    ...options,
    signal: AbortSignal.any([options.signal??AbortSignal.timeout(15000),sessionSignal]),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(clinicRead?clinicReadState.headers():{}),
      ...(options.headers || {}),
    },
  }).catch((error) => {
    throw new ApiError(ApiErrorCode.SERVER_ERROR, 503, "Cannot connect to the backend server.", error);
  });

  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if(sessionSignal.aborted||token!==authToken.get())throw new DOMException('Session changed','AbortError');
  if(clinicRead&&!retried&&response.status===422&&data?.code==='CLINIC_READ_TOKEN_INVALID'){
    clinicReadState.expired();return request<T>(endpoint,options,true);
  }
  if (!response.ok) {
    throw new ApiError(httpStatusToErrorCode(response.status), response.status, data?.error || "Backend request failed.", data);
  }
  if(clinicRead&&epoch!==clinicReadState.epoch()){
    if(!retried)return request<T>(endpoint,options,true);
    throw new DOMException('A newer mutation superseded this read','AbortError');
  }
  if(clinicWrite)clinicReadState.mutation(response.headers.get('X-Clinic-Read-Token'),data);
  if(clinicRead)clinicReadState.confirmed(data);
  return data as T;
}

export const apiClient = {
  get: <T>(url: string, options: Pick<RequestInit, "signal" | "headers"> = {}) => request<T>(url, { ...options, method: "GET" }),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>(url, { method: "POST", body: JSON.stringify(body), headers }),
  patch: <T>(url: string, body?: unknown) => request<T>(url, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};
