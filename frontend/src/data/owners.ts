import type { Owner } from "../types/owner";

/**
 * Mock owner data — dữ liệu chủ nuôi mẫu.
 * Dữ liệu này đồng bộ với initialState trong AppStoreProvider.
 */
export const mockOwners: Owner[] = [
  {
    id: "owner_1",
    fullName: "Nguyễn Văn A",
    phone: "0901234567",
    email: "owner@example.com",
    address: "Mỹ Đình, Hà Nội",
    petIds: ["pet_mochi", "pet_yuki"],
  },
  {
    id: "owner_2",
    fullName: "Trần Thị B",
    phone: "0912345678",
    email: "tranb@example.com",
    address: "Cầu Giấy, Hà Nội",
    petIds: ["pet_sashimi"],
  },
];
