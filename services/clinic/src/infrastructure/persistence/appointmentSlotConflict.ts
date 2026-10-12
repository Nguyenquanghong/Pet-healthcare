import { BusinessError } from "../../domain/error.js";

const slotIndex = "appointments_active_pet_slot_key";
const slotColumns = ["pet_id", "appointment_date", "appointment_time"];

// Prisma 6 reports this partial-index violation as its three database columns;
// other client versions may report the index name instead.
export async function appointmentSlotWrite<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    const prismaError = error as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } };
    const target = prismaError.meta?.target;
    const isSlot = target === slotIndex ||
      (Array.isArray(target) && target.length === slotColumns.length && slotColumns.every((column, index) => target[index] === column));
    if (prismaError.code === "P2002" && prismaError.meta?.modelName === "Appointment" && isSlot) {
      throw new BusinessError(409, "This pet already has an appointment at the selected time.");
    }
    throw error;
  }
}
