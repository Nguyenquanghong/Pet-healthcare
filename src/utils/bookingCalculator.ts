import type { HotelRoomType, HotelServiceKey } from "../types/booking";
import { daysBetween } from "./date";

export const ROOM_PRICES: Record<HotelRoomType, number> = {
  standard: 3000,
  deluxe: 5500,
};

export const HOTEL_SERVICE_PRICES: Record<HotelServiceKey, { label: string; price: number; unit: "each" | "day" }> = {
  grooming_spa: { label: "Grooming & Spa", price: 4000, unit: "each" },
  special_diet: { label: "Special Diet Plan", price: 1200, unit: "day" },
  video_call: { label: "Video Call", price: 1000, unit: "each" },
  daily_walk: { label: "Daily Walk", price: 800, unit: "day" },
  medicine_support: { label: "Medicine Support", price: 700, unit: "day" },
};

export const calculateNights = daysBetween;

export const calculateServiceTotal = (serviceKeys: HotelServiceKey[], nights: number) =>
  serviceKeys.reduce((total, key) => {
    const service = HOTEL_SERVICE_PRICES[key];
    return total + service.price * (service.unit === "day" ? nights : 1);
  }, 0);

export const calculateBookingTotal = (roomType: HotelRoomType, serviceKeys: HotelServiceKey[], nights: number) =>
  ROOM_PRICES[roomType] * nights + calculateServiceTotal(serviceKeys, nights);