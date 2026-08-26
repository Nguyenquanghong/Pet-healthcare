import crypto from "node:crypto";
import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { petDto } from "../lib/serialize.js";

export const petsRouter = Router();

function petData(body: Record<string, unknown>): Prisma.PetUpdateInput {
  const profile = typeof body.publicProfile === "object" && body.publicProfile ? body.publicProfile as Record<string, unknown> : {};
  return {
    ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
    ...(body.species !== undefined ? { species: body.species as never } : {}),
    ...(body.breed !== undefined ? { breed: String(body.breed).trim() || null } : {}),
    ...(body.gender !== undefined ? { gender: body.gender as never } : {}),
    ...(body.ageLabel !== undefined ? { ageLabel: String(body.ageLabel).trim() || null } : {}),
    ...(body.weightKg !== undefined ? { weightKg: Number(body.weightKg) || null } : {}),
    ...(body.microchipId !== undefined ? { microchipId: String(body.microchipId).trim() || null } : {}),
    ...(body.healthStatus !== undefined ? { healthStatus: body.healthStatus as never } : {}),
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

petsRouter.get("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const pets = await prisma.pet.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: { createdAt: "desc" } });
  res.json(pets.map(petDto));
});

petsRouter.post("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : String(req.body.ownerId || "");
  if (!ownerId || !String(req.body.name || "").trim()) return res.status(422).json({ error: "Owner and pet name are required." });
  const pet = await prisma.pet.create({
    data: {
      ownerId,
      name: String(req.body.name).trim(),
      species: (req.body.species || "other") as never,
      gender: (req.body.gender || "unknown") as never,
      healthStatus: (req.body.healthStatus || "healthy") as never,
      allergies: Array.isArray(req.body.allergies) ? req.body.allergies.map(String) : [],
      qrToken: crypto.randomBytes(18).toString("base64url"),
      ...(petData(req.body) as object),
    },
  });
  res.status(201).json({ pet: petDto(pet) });
});

petsRouter.patch("/:id", async (req, res) => {
  const pet = await prisma.pet.findUnique({ where: { id: req.params.id } });
  if (!pet) return res.status(404).json({ error: "Pet not found." });
  if (req.auth!.role === "owner" && pet.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot update this pet." });
  const updated = await prisma.pet.update({ where: { id: pet.id }, data: petData(req.body) });
  res.json({ pet: petDto(updated) });
});
