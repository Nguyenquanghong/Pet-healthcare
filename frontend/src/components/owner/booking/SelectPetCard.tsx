import type { Pet } from "../../../types/pet";
import { PetLookup } from "../../ui/PagedSelect";

interface SelectPetCardProps {
  ownerPets: Pet[];
  petId: string;
  onPetChange: (value: string) => void;
}

export function SelectPetCard({ petId, onPetChange }: SelectPetCardProps) {
  return (
    <PetLookup label="Thú cưng" value={petId} onChange={onPetChange} />
  );
}