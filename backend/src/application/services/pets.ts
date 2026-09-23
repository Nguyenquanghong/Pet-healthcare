import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { PetChanges, PetRepository, QrTokenPort } from "../ports/pets.js";

function petData(body: Record<string, unknown>): PetChanges {
  const profile = typeof body.publicProfile === "object" && body.publicProfile ? body.publicProfile as Record<string, unknown> : {};
  return {
    ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
    ...(body.species !== undefined ? { species: String(body.species) } : {}),
    ...(body.breed !== undefined ? { breed: String(body.breed).trim() || null } : {}),
    ...(body.gender !== undefined ? { gender: String(body.gender) } : {}),
    ...(body.ageLabel !== undefined ? { ageLabel: String(body.ageLabel).trim() || null } : {}),
    ...(body.weightKg !== undefined ? { weightKg: Number(body.weightKg) || null } : {}),
    ...(body.microchipId !== undefined ? { microchipId: String(body.microchipId).trim() || null } : {}),
    ...(body.healthStatus !== undefined ? { healthStatus: String(body.healthStatus) } : {}),
    ...(body.allergies !== undefined ? { allergies: Array.isArray(body.allergies) ? body.allergies.map(String) : [] } : {}),
    ...(body.notes !== undefined ? { notes: String(body.notes).trim() || null } : {}),
    ...(body.avatarUrl !== undefined ? { avatarUrl: String(body.avatarUrl) || null } : {}),
    ...(body.identifyingMarks !== undefined ? { identifyingMarks: String(body.identifyingMarks).trim() || null } : {}),
    ...(body.lastSeenLocation !== undefined ? { lastSeenLocation: String(body.lastSeenLocation).trim() || null } : {}),
    ...(body.qrToken !== undefined ? { qrToken: String(body.qrToken).trim() || null } : {}),
    ...(body.qrEnabled !== undefined ? { qrEnabled: Boolean(body.qrEnabled) } : {}),
    ...(profile.showOwnerPhone !== undefined ? { showOwnerPhone: Boolean(profile.showOwnerPhone) } : {}),
    ...(profile.showOwnerEmail !== undefined ? { showOwnerEmail: Boolean(profile.showOwnerEmail) } : {}),
    ...(profile.showOwnerAddress !== undefined ? { showOwnerAddress: Boolean(profile.showOwnerAddress) } : {}),
    ...(profile.showMedicalAlerts !== undefined ? { showMedicalAlerts: Boolean(profile.showMedicalAlerts) } : {}),
    ...(profile.rescueNote !== undefined ? { rescueNote: String(profile.rescueNote).trim() || null } : {}),
  };
}

export class PetsService {
  constructor(private readonly pets: PetRepository, private readonly qrTokens: QrTokenPort) {}

  list(actor: Actor, requestedOwnerId?: string) {
    return this.pets.list(actor.role === "owner" ? actor.sub : requestedOwnerId);
  }

  async create(actor: Actor, body: Record<string, unknown>) {
    const ownerId = actor.role === "owner" ? actor.sub : String(body.ownerId || "");
    if (!ownerId || !String(body.name || "").trim()) throw new BusinessError(422, "Owner and pet name are required.");
    return this.pets.create({
      ownerId, name: String(body.name).trim(), species: String(body.species || "other"),
      gender: String(body.gender || "unknown"), healthStatus: String(body.healthStatus || "healthy"),
      allergies: Array.isArray(body.allergies) ? body.allergies.map(String) : [],
      qrToken: this.qrTokens.create(), ...petData(body),
    });
  }

  async update(actor: Actor, id: string, body: Record<string, unknown>) {
    const pet = await this.pets.find(id);
    if (!pet) throw new BusinessError(404, "Pet not found.");
    if (actor.role === "owner" && pet.ownerId !== actor.sub) throw new BusinessError(403, "You cannot update this pet.");
    return this.pets.update(pet.id, petData(body));
  }
}
