import type { ApiSchemas } from "./generated/api";

// AQ-07: generated from the OpenAPI contract (types/generated/api.ts).
export type HotelBooking = ApiSchemas["HotelBooking"];
export type HotelRoomType = HotelBooking["roomType"];
export type HotelBookingStatus = HotelBooking["status"];
export type DailyCareNote = ApiSchemas["CareNote"];
// UI choices; the API accepts any service key it prices and returns string[].
export type HotelServiceKey = "grooming_spa" | "special_diet" | "video_call" | "daily_walk" | "medicine_support";
