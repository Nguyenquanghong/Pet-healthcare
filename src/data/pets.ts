import type { Pet } from "../types/pet";

/**
 * Mock pet data — dữ liệu thú cưng mẫu.
 * Đồng bộ với initialState trong AppStoreProvider.
 */
export const mockPets: Pet[] = [
  {
    id: "pet_mochi",
    ownerId: "owner_1",
    name: "Mochi",
    species: "dog",
    breed: "Shiba Inu",
    gender: "male",
    ageLabel: "2 tuổi",
    weightKg: 8.4,
    microchipId: "JP-2026-MOCHI",
    healthStatus: "healthy",
    allergies: ["Không"],
  },
  {
    id: "pet_yuki",
    ownerId: "owner_1",
    name: "Yuki",
    species: "dog",
    breed: "Shiba Inu",
    gender: "female",
    ageLabel: "1 tuổi",
    weightKg: 7.2,
    microchipId: "JP-2026-YUKI",
    healthStatus: "stable",
    allergies: ["Thịt bò"],
  },
  {
    id: "pet_sashimi",
    ownerId: "owner_2",
    name: "Sashimi",
    species: "cat",
    breed: "Scottish Fold",
    gender: "female",
    ageLabel: "1 tuổi",
    weightKg: 4.1,
    healthStatus: "vaccination_due",
  },
];
