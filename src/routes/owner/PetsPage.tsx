import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Edit3, ImagePlus, Plus, Sparkles, Trash2 } from "lucide-react";
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
  microchipId: string;
  healthStatus: PetHealthStatus;
  allergies: string;
  notes: string;
  identifyingMarks: string;
  lastSeenLocation: string;
  avatarUrl: string;
};

type PetFormErrors = Partial<Record<"name" | "breed" | "ageLabel" | "avatarUrl", string>>;

const emptyForm: PetFormState = {
  name: "",
  species: "dog",
  breed: "",
  gender: "unknown",
  ageLabel: "",
  microchipId: "",
  healthStatus: "healthy",
  allergies: "",
  notes: "",
  identifyingMarks: "",
  lastSeenLocation: "",
  avatarUrl: "",
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

function formFromPet(pet: Pet): PetFormState {
  return {
    name: pet.name,
    species: pet.species,
    breed: pet.breed,
    gender: pet.gender,
    ageLabel: pet.ageLabel,
    microchipId: pet.microchipId ?? "",
    healthStatus: pet.healthStatus,
    allergies: pet.allergies?.join(", ") ?? "",
    notes: pet.notes ?? "",
    identifyingMarks: pet.identifyingMarks ?? "",
    lastSeenLocation: pet.lastSeenLocation ?? "",
    avatarUrl: pet.avatarUrl ?? "",
  };
}

export function PetsPage() {
  const { createPet, medicalImages, medicalRecords, ownerPets, updatePet } = useAppStore();
  const [selectedPetId, setSelectedPetId] = useState(ownerPets[0]?.id ?? "");
  const [formMode, setFormMode] = useState<PetFormMode>("create");
  const [showForm, setShowForm] = useState(ownerPets.length === 0);
  const [form, setForm] = useState<PetFormState>(emptyForm);
  const [editDrafts, setEditDrafts] = useState<Record<string, PetFormState>>({});
  const [errors, setErrors] = useState<PetFormErrors>({});
  const [successMsg, setSuccessMsg] = useState("");

  const selectedPet = useMemo(
    () => ownerPets.find((pet) => pet.id === selectedPetId) ?? ownerPets[0],
    [ownerPets, selectedPetId],
  );
  const selectedPetRecords = useMemo(
    () => medicalRecords.filter((record) => record.petId === selectedPet?.id),
    [medicalRecords, selectedPet?.id],
  );
  const selectedPetImages = useMemo(
    () => medicalImages.filter((image) => image.petId === selectedPet?.id),
    [medicalImages, selectedPet?.id],
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
    setEditDrafts({});
    setErrors({});
    setShowForm(true);
  };

  const openEditForm = () => {
    if (!selectedPet) return;
    const initialForm = formFromPet(selectedPet);
    setFormMode("edit");
    setForm(initialForm);
    setEditDrafts({ [selectedPet.id]: initialForm });
    setErrors({});
    setShowForm(true);
  };

  const selectPet = (pet: Pet) => {
    if (pet.id === selectedPet?.id) return;

    if (showForm && formMode === "edit" && selectedPet) {
      const nextDrafts = { ...editDrafts, [selectedPet.id]: form };
      setEditDrafts(nextDrafts);
      setForm(nextDrafts[pet.id] ?? formFromPet(pet));
      setErrors({});
    }

    setSelectedPetId(pet.id);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditDrafts({});
    setErrors({});
  };

  const validate = () => {
    const nextErrors: PetFormErrors = {};
    if (!form.name.trim()) nextErrors.name = "Vui lòng nhập tên thú cưng.";
    if (!form.breed.trim()) nextErrors.breed = "Vui lòng nhập giống hoặc mô tả ngắn.";
    if (!form.ageLabel.trim()) nextErrors.ageLabel = "Vui lòng nhập tuổi ước tính.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setErrors((current) => ({ ...current, avatarUrl: "Vui lòng chọn file ảnh hợp lệ." }));
      event.target.value = "";
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setErrors((current) => ({ ...current, avatarUrl: "Ảnh không được vượt quá 2MB." }));
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      updateField("avatarUrl", String(reader.result || ""));
      setErrors((current) => ({ ...current, avatarUrl: undefined }));
    };
    reader.readAsDataURL(file);
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
      microchipId: form.microchipId.trim() || undefined,
      healthStatus: form.healthStatus,
      allergies: form.allergies.split(",").map((item) => item.trim()).filter(Boolean),
      notes: form.notes.trim() || undefined,
      identifyingMarks: form.identifyingMarks.trim() || undefined,
      lastSeenLocation: form.lastSeenLocation.trim() || undefined,
      avatarUrl: form.avatarUrl || undefined,
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
    setEditDrafts({});
    setTimeout(() => setSuccessMsg(""), 3500);
  };

  return (
    <OwnerLayout title="Hồ sơ thú cưng thông minh">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-extrabold uppercase tracking-[0.2em] text-primary">Pet Profiles</p>
          <h2 className="mt-2 text-3xl font-black text-slate-950">Quản lý hồ sơ thú cưng</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Lưu thông tin cơ bản, dị ứng và trạng thái sức khỏe để đặt lịch khám hoặc hotel booking nhanh hơn.
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
              onClick={() => selectPet(pet)}
              className={`flex min-w-[210px] items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                selectedPet?.id === pet.id
                  ? "border-primary bg-primary text-white shadow-soft"
                  : "border-slate-200 bg-white text-slate-700 hover:border-primary/40 hover:bg-slate-50"
              }`}
            >
              <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white/20 text-xl">
                {pet.avatarUrl ? (
                  <img src={pet.avatarUrl} alt={pet.name} className="h-full w-full object-cover" />
                ) : (
                  <>{pet.species === "cat" ? "🐈" : pet.species === "rabbit" ? "🐇" : pet.species === "dog" ? "🐕" : "🐾"}</>
                )}
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
        <form onSubmit={handleSubmit} noValidate className="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 bg-slate-50/70 px-6 py-5">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-primary">
                {formMode === "edit" ? "Edit pet profile" : "New pet profile"}
              </p>
              <h3 className="mt-1 text-2xl font-black text-slate-950">
                {formMode === "edit" ? "Cập nhật hồ sơ" : "Thêm thú cưng mới"}
              </h3>
              <p className="mt-1 text-sm text-slate-500">Chỉ cần nhập các thông tin nhận diện chính. Trường có dấu * là bắt buộc.</p>
            </div>
            <button type="button" onClick={closeForm} className="rounded-xl px-3 py-2 text-sm font-bold text-slate-500 hover:bg-white hover:text-primary">
              Đóng
            </button>
          </div>

          <div className="grid gap-6 p-6 lg:grid-cols-[280px_1fr]">
            <aside className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="aspect-square overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {form.avatarUrl ? (
                  <img src={form.avatarUrl} alt="Xem trước ảnh thú cưng" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center text-slate-300">
                    <ImagePlus size={42} />
                    <span className="mt-3 text-sm font-bold text-slate-400">Chưa có ảnh</span>
                  </div>
                )}
              </div>
              <p className="mt-4 text-sm font-black text-slate-900">Ảnh thú cưng</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">Ảnh giúp chủ nuôi và người tìm thấy nhận diện pet nhanh hơn.</p>
              <div className="mt-4 grid gap-2">
                <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-soft transition hover:bg-primary-dark">
                  <ImagePlus size={16} />
                  Chọn ảnh
                  <input type="file" accept="image/*" onChange={handleAvatarChange} className="sr-only" />
                </label>
                {form.avatarUrl && (
                  <button
                    type="button"
                    onClick={() => updateField("avatarUrl", "")}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:border-rose-200 hover:text-rose-600"
                  >
                    <Trash2 size={16} />
                    Xóa ảnh
                  </button>
                )}
              </div>
              {errors.avatarUrl && <p className="mt-2 text-sm text-red-500">{errors.avatarUrl}</p>}
            </aside>

            <div className="space-y-6">
              <section>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-base font-black text-slate-900">Thông tin cơ bản</h4>
                    <p className="mt-0.5 text-xs text-slate-500">Dùng cho hồ sơ, đặt lịch và nhận diện nhanh.</p>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <Input label="Tên thú cưng *" value={form.name} error={errors.name} onChange={(event) => updateField("name", event.target.value)} placeholder="Mochi" />
                  <Select label="Loài" options={speciesOptions} value={form.species} onChange={(event) => updateField("species", event.target.value as PetSpecies)} />
                  <Input label="Giống / mô tả *" value={form.breed} error={errors.breed} onChange={(event) => updateField("breed", event.target.value)} placeholder="Shiba Inu, mèo Anh lông ngắn..." />
                  <Select label="Giới tính" options={genderOptions} value={form.gender} onChange={(event) => updateField("gender", event.target.value as PetGender)} />
                  <Input label="Tuổi *" value={form.ageLabel} error={errors.ageLabel} onChange={(event) => updateField("ageLabel", event.target.value)} placeholder="2 tuổi, 8 tháng..." />
                </div>
              </section>

              <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                <h4 className="text-base font-black text-slate-900">Thông tin cứu hộ</h4>
                <p className="mt-0.5 text-xs text-slate-600">Các trường này sẽ giúp ích khi người lạ quét QR cứu hộ.</p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Input label="Dị ứng / lưu ý y tế" value={form.allergies} onChange={(event) => updateField("allergies", event.target.value)} placeholder="Thịt bò, phấn hoa..." />
                  <Input label="Đặc điểm nhận dạng" value={form.identifyingMarks} onChange={(event) => updateField("identifyingMarks", event.target.value)} placeholder="Vòng cổ đỏ, đốm trắng ở chân..." />
                  <Input className="md:col-span-2" label="Khu vực thường gặp" value={form.lastSeenLocation} onChange={(event) => updateField("lastSeenLocation", event.target.value)} placeholder="Mỹ Đình, Hà Nội" />
                </div>
              </section>

              <Textarea label="Ghi chú chăm sóc" value={form.notes} onChange={(event) => updateField("notes", event.target.value)} placeholder="Thói quen ăn uống, thuốc đang dùng, lưu ý khi chăm sóc..." rows={3} />
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-100 bg-slate-50/70 px-6 py-4">
            <Button type="button" variant="outline" onClick={closeForm}>Hủy</Button>
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
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <PetProfileHero pet={selectedPet} />
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <DigitalHealthRecordCard pet={selectedPet} records={selectedPetRecords} />
              <CloudImagingCard pet={selectedPet} images={selectedPetImages} />
            </div>
          </div>

          <div className="space-y-6">
            <SmartQrToken pet={selectedPet} />
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
