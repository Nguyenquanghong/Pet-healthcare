import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Textarea } from "../../components/ui/Textarea";
import type { Pet } from "../../types/pet";

export type PetDraft = {
  name: string; species: Pet["species"]; gender: Pet["gender"]; breed: string;
  ageLabel: string; weightKg: string; healthStatus: Pet["healthStatus"]; allergies: string; notes: string;
};
export const emptyPetDraft = (): PetDraft => ({
  name: "", species: "dog", gender: "unknown", breed: "", ageLabel: "", weightKg: "",
  healthStatus: "healthy", allergies: "", notes: "",
});
export const speciesLabels = { dog: "Chó", cat: "Mèo", rabbit: "Thỏ", other: "Khác" };
export const genderLabels = { male: "Đực", female: "Cái", unknown: "Chưa rõ" };
export const healthLabels = {
  healthy: "Khỏe mạnh", stable: "Ổn định", vaccination_due: "Cần tiêm phòng",
  under_treatment: "Đang điều trị", critical: "Nguy kịch",
};

export function PetDraftFields({ value, onChange }: { value: PetDraft; onChange: (value: PetDraft) => void }) {
  const set = (field: keyof PetDraft, next: string) => onChange({ ...value, [field]: next });
  return <div className="space-y-4">
    <Input id="reception-pet-name" label="Tên thú cưng" required maxLength={100} value={value.name} onChange={e => set("name", e.target.value)} />
    <div className="grid gap-4 sm:grid-cols-2">
      <Select id="reception-species" label="Loài" value={value.species} onChange={e => set("species", e.target.value)}
        options={Object.entries(speciesLabels).map(([value, label]) => ({ value, label }))} />
      <Select id="reception-gender" label="Giới tính" value={value.gender} onChange={e => set("gender", e.target.value)}
        options={Object.entries(genderLabels).map(([value, label]) => ({ value, label }))} />
      <Input id="reception-breed" label="Giống" maxLength={100} value={value.breed} onChange={e => set("breed", e.target.value)} />
      <Input id="reception-age" label="Tuổi (nếu biết)" maxLength={100} placeholder="Ví dụ: 2 tuổi" value={value.ageLabel} onChange={e => set("ageLabel", e.target.value)} />
      <Input id="reception-weight" label="Cân nặng (kg)" type="number" min="0.01" step="0.01" value={value.weightKg} onChange={e => set("weightKg", e.target.value)} />
      <Select id="reception-health" label="Tình trạng sức khỏe" value={value.healthStatus} onChange={e => set("healthStatus", e.target.value)}
        options={Object.entries(healthLabels).map(([value, label]) => ({ value, label }))} />
    </div>
    <Input id="reception-allergies" label="Dị ứng" maxLength={500} placeholder="Phân cách bằng dấu phẩy" value={value.allergies} onChange={e => set("allergies", e.target.value)} />
    <Textarea id="reception-pet-notes" label="Ghi chú thú cưng" maxLength={2000} rows={3} value={value.notes} onChange={e => set("notes", e.target.value)} />
  </div>;
}
