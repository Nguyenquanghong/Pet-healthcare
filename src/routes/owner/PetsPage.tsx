import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Edit3, Plus, Sparkles } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { PetProfileHero } from "../../components/owner/pets/PetProfileHero";
import { SmartQrToken } from "../../components/owner/pets/SmartQrToken";
import { DigitalHealthRecordCard } from "../../components/owner/pets/DigitalHealthRecordCard";
import { CloudImagingCard } from "../../components/owner/pets/CloudImagingCard";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Textarea } from "../../components/ui/Textarea";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Pet, PetGender, PetHealthStatus, PetSpecies } from "../../types/pet";

type PetFormMode = "create" | "edit";

type PetFormState = {
  name: string;
  species: PetSpecies;
  breed: string;
  gender: PetGender;
  ageLabel: string;
  weightKg: string;
  microchipId: string;
  healthStatus: PetHealthStatus;
  allergies: string;
  notes: string;
};

type PetFormErrors = Partial<Record<"name" | "breed" | "ageLabel", string>>;

const emptyForm: PetFormState = {
  name: "",
  species: "dog",
  breed: "",
  gender: "unknown",
  ageLabel: "",
  weightKg: "",
  microchipId: "",
  healthStatus: "healthy",
  allergies: "",
  notes: "",
};

const speciesOptions = [
  { value: "dog", label: "Chó" },
  { value: "cat", label: "Mèo" },
  { value: "rabbit", label: "Thỏ" },
  { value: "other", label: "Khác" },
];

const genderOptions = [
  { value: "unknown", label: "Chưa rõ" },
  { value: "male", label: "Đực" },
  { value: "female", label: "Cái" },
];

const healthStatusOptions = [
  { value: "healthy", label: "Khỏe mạnh" },
  { value: "stable", label: "Ổn định" },
  { value: "vaccination_due", label: "Cần tiêm phòng" },
  { value: "under_treatment", label: "Đang điều trị" },
  { value: "critical", label: "Cần theo dõi sát" },
];

const statusLabels: Record<PetHealthStatus, string> = {
  healthy: "Khỏe mạnh",
  stable: "Ổn định",
  vaccination_due: "Cần tiêm phòng",
  under_treatment: "Đang điều trị",
  critical: "Cần theo dõi sát",
};

const statusStyles: Record<PetHealthStatus, string> = {
  healthy: "bg-emerald-50 text-emerald-700 border-emerald-200",
  stable: "bg-blue-50 text-blue-700 border-blue-200",
  vaccination_due: "bg-amber-50 text-amber-700 border-amber-200",
  under_treatment: "bg-orange-50 text-orange-700 border-orange-200",
  critical: "bg-rose-50 text-rose-700 border-rose-200",
};

function formFromPet(pet: Pet): PetFormState {
  return {
    name: pet.name,
    species: pet.species,
    breed: pet.breed,
    gender: pet.gender,
    ageLabel: pet.ageLabel,
    weightKg: pet.weightKg?.toString() ?? "",
    microchipId: pet.microchipId ?? "",
    healthStatus: pet.healthStatus,
    allergies: pet.allergies?.join(", ") ?? "",
    notes: pet.notes ?? "",
  };
}

export function PetsPage() {
  const { createPet, ownerPets, updatePet } = useAppStore();
  const [selectedPetId, setSelectedPetId] = useState(ownerPets[0]?.id ?? "");
  const [formMode, setFormMode] = useState<PetFormMode>("create");
  const [showForm, setShowForm] = useState(ownerPets.length === 0);
  const [form, setForm] = useState<PetFormState>(emptyForm);
  const [errors, setErrors] = useState<PetFormErrors>({});
  const [successMsg, setSuccessMsg] = useState("");

  const selectedPet = useMemo(
    () => ownerPets.find((pet) => pet.id === selectedPetId) ?? ownerPets[0],
    [ownerPets, selectedPetId],
  );

  useEffect(() => {
    if (!selectedPetId && ownerPets[0]) setSelectedPetId(ownerPets[0].id);
  }, [ownerPets, selectedPetId]);

  const updateField = <K extends keyof PetFormState>(key: K, value: PetFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const openCreateForm = () => {
    setFormMode("create");
    setForm(emptyForm);
    setErrors({});
    setShowForm(true);
  };

  const openEditForm = () => {
    if (!selectedPet) return;
    setFormMode("edit");
    setForm(formFromPet(selectedPet));
    setErrors({});
    setShowForm(true);
  };

  const validate = () => {
    const nextErrors: PetFormErrors = {};
    if (!form.name.trim()) nextErrors.name = "Vui lòng nhập tên thú cưng.";
    if (!form.breed.trim()) nextErrors.breed = "Vui lòng nhập giống hoặc mô tả ngắn.";
    if (!form.ageLabel.trim()) nextErrors.ageLabel = "Vui lòng nhập tuổi ước tính.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;

    const payload = {
      name: form.name.trim(),
      species: form.species,
      breed: form.breed.trim(),
      gender: form.gender,
      ageLabel: form.ageLabel.trim(),
      weightKg: Number(form.weightKg) || undefined,
      microchipId: form.microchipId.trim() || undefined,
      healthStatus: form.healthStatus,
      allergies: form.allergies.split(",").map((item) => item.trim()).filter(Boolean),
      notes: form.notes.trim() || undefined,
    };

    if (formMode === "edit" && selectedPet) {
      updatePet(selectedPet.id, payload);
      setSuccessMsg(`Đã cập nhật hồ sơ của ${payload.name}.`);
    } else {
      createPet(payload);
      setSuccessMsg(`Đã thêm ${payload.name} vào hồ sơ của bạn.`);
    }

    setShowForm(false);
    setForm(emptyForm);
    setTimeout(() => setSuccessMsg(""), 3500);
  };

  return (
    <OwnerLayout title="Hồ sơ thú cưng thông minh">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-primary">Pet Profiles</p>
          <h2 className="mt-2 text-3xl font-black text-slate-950">Quản lý hồ sơ thú cưng</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Lưu thông tin cơ bản, dị ứng, microchip và trạng thái sức khỏe để đặt lịch khám hoặc hotel booking nhanh hơn.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {selectedPet && (
            <Button variant="outline" icon={<Edit3 size={16} />} onClick={openEditForm}>
              Sửa hồ sơ
            </Button>
          )}
          <Button icon={<Plus size={16} />} onClick={openCreateForm}>
            Thêm thú cưng
          </Button>
        </div>
      </div>

      {successMsg && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm font-semibold text-emerald-800">
          <CheckCircle2 size={18} /> {successMsg}
        </div>
      )}

      {ownerPets.length > 0 && (
        <div className="mb-6 flex gap-3 overflow-x-auto pb-2">
          {ownerPets.map((pet) => (
            <button
              key={pet.id}
              type="button"
              onClick={() => setSelectedPetId(pet.id)}
              className={`flex min-w-[210px] items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                selectedPet?.id === pet.id
                  ? "border-primary bg-primary text-white shadow-soft"
                  : "border-slate-200 bg-white text-slate-700 hover:border-primary/40 hover:bg-slate-50"
              }`}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 text-xl">
                {pet.species === "cat" ? "🐈" : pet.species === "rabbit" ? "🐇" : pet.species === "dog" ? "🐕" : "🐾"}
              </span>
              <span>
                <span className="block font-black">{pet.name}</span>
                <span className={`text-xs ${selectedPet?.id === pet.id ? "text-white/80" : "text-slate-500"}`}>{pet.breed}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} noValidate className="mb-8 rounded-2xl border border-primary/20 bg-white p-6 shadow-soft">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-xl font-black text-slate-900">{formMode === "edit" ? "Cập nhật hồ sơ" : "Thêm thú cưng mới"}</h3>
              <p className="mt-1 text-sm text-slate-500">Các trường tên, giống và tuổi là bắt buộc.</p>
            </div>
            <button type="button" onClick={() => setShowForm(false)} className="text-sm font-semibold text-slate-500 hover:text-primary">
              Đóng
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Input label="Tên thú cưng *" value={form.name} error={errors.name} onChange={(event) => updateField("name", event.target.value)} placeholder="Mochi" />
            <Select label="Loài" options={speciesOptions} value={form.species} onChange={(event) => updateField("species", event.target.value as PetSpecies)} />
            <Input label="Giống / mô tả *" value={form.breed} error={errors.breed} onChange={(event) => updateField("breed", event.target.value)} placeholder="Shiba Inu, Mèo Anh lông ngắn..." />
            <Select label="Giới tính" options={genderOptions} value={form.gender} onChange={(event) => updateField("gender", event.target.value as PetGender)} />
            <Input label="Tuổi *" value={form.ageLabel} error={errors.ageLabel} onChange={(event) => updateField("ageLabel", event.target.value)} placeholder="2 tuổi, 8 tháng..." />
            <Input type="number" min="0" step="0.1" label="Cân nặng (kg)" value={form.weightKg} onChange={(event) => updateField("weightKg", event.target.value)} placeholder="8.4" />
            <Select label="Tình trạng sức khỏe" options={healthStatusOptions} value={form.healthStatus} onChange={(event) => updateField("healthStatus", event.target.value as PetHealthStatus)} />
            <Input label="Microchip ID" value={form.microchipId} onChange={(event) => updateField("microchipId", event.target.value)} placeholder="JP-2026-MOCHI" />
            <Input label="Dị ứng" value={form.allergies} onChange={(event) => updateField("allergies", event.target.value)} placeholder="Thịt bò, phấn hoa..." />
            <Textarea className="md:col-span-2 xl:col-span-3" label="Ghi chú chăm sóc" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} placeholder="Thói quen ăn uống, thuốc đang dùng, lưu ý khi chăm sóc..." rows={3} />
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Hủy</Button>
            <Button type="submit" icon={formMode === "edit" ? <Edit3 size={16} /> : <Plus size={16} />}>
              {formMode === "edit" ? "Lưu thay đổi" : "Thêm thú cưng"}
            </Button>
          </div>
        </form>
      )}

      {!selectedPet ? (
        <EmptyState
          icon={<Sparkles size={42} />}
          title="Bạn chưa có hồ sơ thú cưng"
          description="Hãy thêm thú cưng đầu tiên để bắt đầu đặt lịch khám, lưu hồ sơ y tế và sử dụng dịch vụ khách sạn."
          action={<Button icon={<Plus size={16} />} onClick={openCreateForm}>Thêm thú cưng đầu tiên</Button>}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            <PetProfileHero pet={selectedPet} />
            <div className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Tuổi</p>
                <p className="mt-1 font-black text-slate-900">{selectedPet.ageLabel}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Cân nặng</p>
                <p className="mt-1 font-black text-slate-900">{selectedPet.weightKg ? `${selectedPet.weightKg} kg` : "—"}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Tình trạng</p>
                <span className={`mt-1 inline-flex rounded-lg border px-2.5 py-1 text-xs font-bold ${statusStyles[selectedPet.healthStatus]}`}>
                  {statusLabels[selectedPet.healthStatus]}
                </span>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Dị ứng</p>
                <p className="mt-1 font-black text-slate-900">{selectedPet.allergies?.join(", ") || "Không ghi nhận"}</p>
              </div>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <DigitalHealthRecordCard />
              <CloudImagingCard />
            </div>
          </div>

          <div className="space-y-6">
            <SmartQrToken />
            {selectedPet.notes && (
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Ghi chú chăm sóc</p>
                <p className="mt-2 text-sm leading-6 text-slate-700">{selectedPet.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </OwnerLayout>
  );
}