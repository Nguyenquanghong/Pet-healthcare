import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, PawPrint, Plus, Printer } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { PetVitalsSummary } from "../../components/owner/medical/PetVitalsSummary";
import { ClinicalTimeline } from "../../components/owner/medical/ClinicalTimeline";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Select } from "../../components/ui/Select";
import { useAppStore } from "../../store/AppStoreProvider";

const genderLabels = {
  male: "Đực",
  female: "Cái",
  unknown: "Chưa rõ",
};

export function MedicalRecordsPage() {
  const { medicalRecords, ownerPets } = useAppStore();
  const [searchParams] = useSearchParams();
  const requestedPetId = searchParams.get("petId");
  const [selectedPetId, setSelectedPetId] = useState(() =>
    ownerPets.some((pet) => pet.id === requestedPetId) ? requestedPetId ?? "" : ownerPets[0]?.id ?? "",
  );

  useEffect(() => {
    if (requestedPetId && ownerPets.some((pet) => pet.id === requestedPetId)) {
      setSelectedPetId(requestedPetId);
    } else if (!ownerPets.some((pet) => pet.id === selectedPetId)) {
      setSelectedPetId(ownerPets[0]?.id ?? "");
    }
  }, [ownerPets, requestedPetId, selectedPetId]);

  const pet = ownerPets.find((item) => item.id === selectedPetId);
  const petRecords = useMemo(
    () => medicalRecords.filter((record) => record.petId === selectedPetId).sort((a, b) => b.visitDate.localeCompare(a.visitDate)),
    [medicalRecords, selectedPetId],
  );

  return (
    <OwnerLayout title="Hồ sơ y tế chi tiết">
      {ownerPets.length === 0 ? (
        <EmptyState
          icon={<PawPrint size={42} />}
          title="Bạn chưa có hồ sơ thú cưng"
          description="Hồ sơ y tế sẽ được lưu theo từng thú cưng. Hãy thêm thú cưng đầu tiên để bắt đầu theo dõi lịch sử khám."
          action={<Link to="/owner/pets"><Button icon={<Plus size={16} />}>Thêm thú cưng</Button></Link>}
        />
      ) : pet ? (
        <>
          <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 overflow-hidden rounded-full border border-slate-200 bg-slate-50">
                <img
                  src={pet.avatarUrl || `https://api.dicebear.com/7.x/shapes/svg?seed=${pet.name}&backgroundColor=f1f5f9`}
                  alt={pet.name}
                  className="h-full w-full object-cover"
                />
              </div>
              <div>
                <h2 className="text-2xl font-black text-slate-900">{pet.name} ({pet.breed})</h2>
                <p className="text-sm text-slate-600">{pet.ageLabel} &bull; {genderLabels[pet.gender]} &bull; {petRecords.length} hồ sơ y tế</p>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Select
                label="Chọn thú cưng"
                value={selectedPetId}
                options={ownerPets.map((item) => ({ value: item.id, label: `${item.name} — ${item.breed}` }))}
                onChange={(event) => setSelectedPetId(event.target.value)}
                className="min-w-[260px]"
              />
              <div className="flex gap-3 sm:pt-6">
                <Button variant="outline" icon={<Printer size={16} />}>Print</Button>
                <Button icon={<Download size={16} />}>Export</Button>
              </div>
            </div>
          </div>

          <div className="mb-6">
            <PetVitalsSummary pet={pet} latestRecord={petRecords[0]} />
          </div>

          <div className="grid gap-6">
            <ClinicalTimeline records={petRecords} />
          </div>
        </>
      ) : null}
    </OwnerLayout>
  );
}
