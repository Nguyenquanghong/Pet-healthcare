import { Router, Request, Response } from "express";
import { db } from "../db";

export const petsRouter = Router();

// GET /api/pets
petsRouter.get("/", (req: Request, res: Response) => {
  const { ownerId } = req.query;
  let pets = db.get().pets;
  if (ownerId) {
    pets = pets.filter((p) => p.ownerId === String(ownerId));
  }
  return res.json(pets);
});

// GET /api/pets/:id
petsRouter.get("/:id", (req: Request, res: Response) => {
  const pet = db.get().pets.find((p) => p.id === req.params.id);
  if (!pet) return res.status(404).json({ error: "Không tìm thấy thú cưng" });
  return res.json(pet);
});

// POST /api/pets
petsRouter.post("/", (req: Request, res: Response) => {
  const { ownerId, name, species, breed, gender, ageLabel, weightKg, microchipId, healthStatus, allergies, notes } = req.body;
  if (!name || !species) {
    return res.status(422).json({ error: "Tên thú cưng và loài là bắt buộc" });
  }

  const newPet = {
    id: `pet_${Date.now()}`,
    ownerId: ownerId || "owner_1",
    name: name.trim(),
    species: species || "dog",
    breed: breed?.trim(),
    gender: gender || "unknown",
    ageLabel: ageLabel?.trim() || "1 tuổi",
    weightKg: Number(weightKg) || undefined,
    microchipId: microchipId?.trim() || undefined,
    healthStatus: healthStatus || "healthy",
    allergies: Array.isArray(allergies) ? allergies : typeof allergies === "string" ? allergies.split(",").map((s: string) => s.trim()) : [],
    notes: notes?.trim(),
    createdAt: new Date().toISOString(),
  };

  db.update((draft) => {
    draft.pets.unshift(newPet);
  });

  return res.status(201).json({ message: "Thêm thú cưng thành công", pet: newPet });
});

// PATCH /api/pets/:id
petsRouter.patch("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const petIndex = db.get().pets.findIndex((p) => p.id === id);
  if (petIndex === -1) return res.status(404).json({ error: "Không tìm thấy thú cưng" });

  let updatedPet: any;
  db.update((draft) => {
    draft.pets[petIndex] = {
      ...draft.pets[petIndex],
      ...req.body,
    };
    updatedPet = draft.pets[petIndex];
  });

  return res.json({ message: "Cập nhật thông tin thú cưng thành công", pet: updatedPet });
});

// DELETE /api/pets/:id
petsRouter.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  db.update((draft) => {
    draft.pets = draft.pets.filter((p) => p.id !== id);
  });
  return res.json({ message: "Đã xóa thú cưng" });
});
