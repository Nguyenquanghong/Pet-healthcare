import type { Pet } from "../../../types/pet";
import { Select } from "../../ui/Select";

interface SelectPetCardProps {
  ownerPets: Pet[];
  petId: string;
  onPetChange: (value: string) => void;
}

export function SelectPetCard({ ownerPets, petId, onPetChange }: SelectPetCardProps) {
  return (
    <Select
      label="Thú cưng"
      value={petId}
      options={[
        { value: "", label: "Chọn thú cưng" },
        ...ownerPets.map((pet) => ({ value: pet.id, label: `${pet.name} — ${pet.breed}` })),
      ]}
      onChange={(event) => onPetChange(event.target.value)}
    />
  );
}