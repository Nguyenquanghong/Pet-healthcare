import type { HotelRoomType, HotelServiceKey } from "../types/booking";
import { daysBetween } from "./date";
import pricing from "../../../backend/src/domain/pricing.json";

export const ROOM_PRICES: Record<HotelRoomType, number> = {
  standard: pricing.roomRates.standard,
  deluxe: pricing.roomRates.deluxe,
  vip: pricing.roomRates.vip,
};

export const HOTEL_SERVICE_PRICES: Record<HotelServiceKey, { label: string; price: number; unit: "each" | "day" }> = {
  grooming_spa: { label: "Grooming & Spa", price: pricing.hotelServiceRates.grooming_spa, unit: "day" },
  special_diet: { label: "Special Diet Plan", price: pricing.hotelServiceRates.special_diet, unit: "day" },
  video_call: { label: "Video Call", price: pricing.hotelServiceRates.video_call, unit: "day" },
  daily_walk: { label: "Daily Walk", price: pricing.hotelServiceRates.daily_walk, unit: "day" },
  medicine_support: { label: "Medicine Support", price: pricing.hotelServiceRates.medicine_support, unit: "day" },
};

export const calculateNights = daysBetween;

export const calculateServiceTotal = (serviceKeys: HotelServiceKey[], nights: number) =>
  serviceKeys.reduce((total, key) => {
    const service = HOTEL_SERVICE_PRICES[key];
    return total + service.price * (service.unit === "day" ? nights : 1);
  }, 0);

export const calculateBookingTotal = (roomType: HotelRoomType, serviceKeys: HotelServiceKey[], nights: number) =>
  ROOM_PRICES[roomType] * nights + calculateServiceTotal(serviceKeys, nights);
