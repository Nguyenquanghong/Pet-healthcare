import { BusinessError } from "../../domain/error.js";

const stayConstraint = "hotel_bookings_pet_active_stay_excl";

// AQ-10: the exclusion constraint is the database backstop for the pet-lock +
// interval check. Prisma has no dedicated code for exclusion violations
// (SQLSTATE 23P01), so the constraint name or SQLSTATE is matched in the error.
export async function hotelStayWrite<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    const text = `${(error as { message?: unknown })?.message ?? ""} ${JSON.stringify((error as { meta?: unknown })?.meta ?? null)}`;
    if (text.includes(stayConstraint) || /\b23P01\b/.test(text))
      throw new BusinessError(409, "Thú cưng đã có lịch lưu trú trùng khoảng ngày này.");
    throw error;
  }
}
