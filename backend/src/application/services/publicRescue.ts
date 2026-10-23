import { BusinessError } from "../../domain/error.js";
import type { PublicRescueDependencies } from "../ports/publicRescue.js";

export type RescueReportInput = { finderPhone?: string; location?: string; finderName?: string; note?: string };
// AQ-01: the same finder reporting the same pet again within this window is one
// report (double submit, retry, impatient finder): no second row, no second owner
// notification. The per-token limiter bounds everything else.
export const RESCUE_DEDUP_MS = 10 * 60 * 1000;

export class PublicRescueService {
  constructor(private readonly deps: PublicRescueDependencies, private readonly now = () => new Date()) {}

  async getPet(token: string) {
    const result = await this.deps.reads.findEnabledPetWithOwner(token);
    if (!result) throw new BusinessError(404, "This rescue QR code is not available.");
    const { pet, owner } = result;
    return {
      pet,
      owner: {
        id: owner.id, fullName: owner.fullName,
        phone: pet.showOwnerPhone ? owner.phone ?? "" : "",
        email: pet.showOwnerEmail ? owner.email ?? undefined : undefined,
        address: pet.showOwnerAddress ? owner.address ?? undefined : undefined,
        petIds: [pet.id],
      },
    };
  }

  async report(token: string, input: RescueReportInput): Promise<{ merged: boolean }> {
    const pet = await this.deps.reads.findEnabledPetForReport(token);
    if (!pet) throw new BusinessError(404, "This rescue QR code is not available.");
    const finderPhone = typeof input.finderPhone === "string" ? input.finderPhone.trim() : "";
    const location = typeof input.location === "string" ? input.location.trim() : "";
    if (!finderPhone || !location) throw new BusinessError(422, "Phone number and found location are required.");
    return this.deps.unitOfWork.run(async (repo) => {
      await repo.lockPet(pet.id);
      if (await repo.hasRecentReport(pet.id, finderPhone, new Date(this.now().getTime() - RESCUE_DEDUP_MS))) return { merged: true };
      await repo.createReport({ petId: pet.id, finderPhone, location, finderName: input.finderName?.trim() || null, note: input.note?.trim() || null });
      await repo.notifyOwner({
        recipientOwnerId: pet.ownerId, recipientRole: "owner", type: "pet_rescue_report",
        title: `Found report for ${pet.name}`, message: `Found near ${location}. Contact: ${finderPhone}.`,
        actionUrl: "/owner/notifications", relatedPetId: pet.id,
      });
      return { merged: false };
    });
  }
}
