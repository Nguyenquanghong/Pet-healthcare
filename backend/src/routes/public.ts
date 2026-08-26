import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { petDto, publicUser } from "../lib/serialize.js";

export const publicRouter = Router();

publicRouter.get("/pets/:token", async (req, res) => {
  const pet = await prisma.pet.findFirst({
    where: { OR: [{ qrToken: req.params.token }, { id: req.params.token }], qrEnabled: true },
    include: { owner: true },
  });
  if (!pet) return res.status(404).json({ error: "This rescue QR code is not available." });
  const owner = publicUser(pet.owner);
  res.json({
    pet: petDto(pet),
    owner: {
      id: owner.id,
      fullName: owner.fullName,
      phone: pet.showOwnerPhone ? owner.phone : "",
      email: pet.showOwnerEmail ? owner.email : undefined,
      address: pet.showOwnerAddress ? owner.address : undefined,
      petIds: [pet.id],
    },
  });
});

publicRouter.post("/pets/:token/rescue-reports", async (req, res) => {
  const pet = await prisma.pet.findFirst({ where: { OR: [{ qrToken: req.params.token }, { id: req.params.token }], qrEnabled: true } });
  if (!pet) return res.status(404).json({ error: "This rescue QR code is not available." });
  const finderPhone = typeof req.body.finderPhone === "string" ? req.body.finderPhone.trim() : "";
  const location = typeof req.body.location === "string" ? req.body.location.trim() : "";
  if (!finderPhone || !location) return res.status(422).json({ error: "Phone number and found location are required." });

  await prisma.$transaction([
    prisma.rescueReport.create({ data: { petId: pet.id, finderPhone, location, finderName: req.body.finderName?.trim() || null, note: req.body.note?.trim() || null } }),
    prisma.notification.create({ data: { recipientOwnerId: pet.ownerId, recipientRole: "owner", type: "pet_rescue_report", title: `Found report for ${pet.name}`, message: `Found near ${location}. Contact: ${finderPhone}.`, actionUrl: "/owner/notifications", relatedPetId: pet.id } }),
  ]);
  res.status(201).json({ message: "The owner has been notified." });
});
