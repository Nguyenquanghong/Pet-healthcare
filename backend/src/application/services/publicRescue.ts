import { BusinessError } from "../../domain/error.js";
import type { PublicRescueDependencies } from "../ports/publicRescue.js";

export type RescueReportInput = { finderPhone?: string; location?: string; finderName?: string; note?: string };

export class PublicRescueService {
  constructor(private readonly deps: PublicRescueDependencies) {}

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

  async report(token: string, input: RescueReportInput) {
    const pet = await this.deps.reads.findEnabledPetForReport(token);
    if (!pet) throw new BusinessError(404, "This rescue QR code is not available.");
    const finderPhone = typeof input.finderPhone === "string" ? input.finderPhone.trim() : "";
    const location = typeof input.location === "string" ? input.location.trim() : "";
    if (!finderPhone || !location) throw new BusinessError(422, "Phone number and found location are required.");
    await this.deps.unitOfWork.run(async (repo) => {
      await repo.createReport({ petId: pet.id, finderPhone, location, finderName: input.finderName?.trim() || null, note: input.note?.trim() || null });
      await repo.notifyOwner({
        recipientOwnerId: pet.ownerId, recipientRole: "owner", type: "pet_rescue_report",
        title: `Found report for ${pet.name}`, message: `Found near ${location}. Contact: ${finderPhone}.`,
        actionUrl: "/owner/notifications", relatedPetId: pet.id,
      });
    });
  }
}
