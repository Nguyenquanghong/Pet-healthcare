export type ServiceCategory = "clinical" | "vaccination" | "hotel_room" | "hotel_addon" | "grooming";

export type Service = {
  id: string;
  name: string;
  category: ServiceCategory;
  price: number;
  unit: "each" | "night" | "day";
  description?: string;
  isActive: boolean;
};