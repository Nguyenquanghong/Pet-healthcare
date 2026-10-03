import { usePagedList } from "../../services/usePagedList";
import { useApiQuery } from "../../services/useApiQuery";
import type { ListPage } from "../../types/list";
import { Pagination } from "../../components/ui/Pagination";
import { PetLookup } from "../../components/ui/PagedSelect";
import type { MedicalRecord } from "../../types/medicalRecord";
import type { Pet } from "../../types/pet";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, PawPrint, Plus, Printer } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { PetVitalsSummary } from "../../components/owner/medical/PetVitalsSummary";
import { ClinicalTimeline } from "../../components/owner/medical/ClinicalTimeline";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAppStore } from "../../store/AppStoreProvider";

const genderLabels = {
  male: "Đực",
  female: "Cái",
  unknown: "Chưa rõ",
};

export function MedicalRecordsPage() {
  const { ownerPets } = useAppStore();
  const [searchParams] = useSearchParams();
  const requestedPetId = searchParams.get("petId");
  const [selectedPetId, setSelectedPetId] = useState(requestedPetId ?? ownerPets[0]?.id ?? "");
  useEffect(() => { if (requestedPetId) setSelectedPetId(requestedPetId); }, [requestedPetId]);
  useEffect(() => { if (!selectedPetId && ownerPets[0]) setSelectedPetId(ownerPets[0].id); }, [ownerPets, selectedPetId]);
  const selectedPet = usePagedList<Pet>("/pets", { id: selectedPetId }, Boolean(selectedPetId));
  const list = usePagedList<MedicalRecord>("/medical-records", { petId: selectedPetId }, Boolean(selectedPetId));
  const latest = useApiQuery<ListPage<MedicalRecord>>(`/medical-records?petId=${encodeURIComponent(selectedPetId)}&page=1&pageSize=1`, {
    enabled: Boolean(selectedPetId), refreshOnTick: true,
  });
  const medicalRecords = list.items;

  const pet = selectedPet.items[0] ?? ownerPets.find((item) => item.id === selectedPetId);
  const petRecords = useMemo(
    () => medicalRecords.filter((record) => record.petId === selectedPetId).sort((a, b) => b.visitDate.localeCompare(a.visitDate)),
    [medicalRecords, selectedPetId],
  );

  return (
    <OwnerLayout title="Hồ sơ y tế chi tiết">
      <div className="mb-6"><PetLookup label="Chọn thú cưng" value={selectedPetId} onChange={setSelectedPetId} /></div>
      {ownerPets.length === 0 ? (
        <EmptyState
          icon={<PawPrint size={42} />}
          title="Bạn chưa có hồ sơ thú cưng"
          description="Hồ sơ y tế sẽ được lưu theo từng thú cưng. Hãy thêm thú cưng đầu tiên để bắt đầu theo dõi lịch sử khám."
          action={<Link to="/owner/pets"><Button icon={<Plus size={16} />}>Thêm thú cưng</Button></Link>}
        />
      ) : pet ? (
        <>
          <div className="mb-6 flex flex-col gap-4 border-b border-slate-200 bg-white px-0 pb-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 overflow-hidden rounded-full border border-slate-200 bg-slate-50">
                <img
                  src={pet.avatarUrl || `https://api.dicebear.com/7.x/shapes/svg?seed=${pet.name}&backgroundColor=f1f5f9`}
                  alt={pet.name}
                  className="h-full w-full object-cover"
                />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-900">{pet.name} ({pet.breed})</h2>
                <p className="text-sm text-slate-600">{pet.ageLabel} &bull; {genderLabels[pet.gender]} &bull; {list.pagination.total} hồ sơ y tế</p>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex gap-3 sm:pt-6">
                <Button variant="outline" icon={<Printer size={16} />}>Print</Button>
                <Button icon={<Download size={16} />}>Export</Button>
              </div>
            </div>
          </div>

          <div className="mb-6">
            <PetVitalsSummary pet={pet} latestRecord={latest.data?.items[0]} />
            {latest.loading && !latest.data && <p role="status" className="mt-2 text-sm text-slate-500">Đang tải chỉ số sức khỏe mới nhất...</p>}
            {latest.error && <p role="alert" className="mt-2 text-sm text-amber-800">Chưa cập nhật được chỉ số sức khỏe mới nhất. <button className="underline" onClick={() => void latest.reload().catch(() => undefined)}>Thử lại chỉ số</button></p>}
          </div>

          <div className="grid gap-6">
            <Pagination {...list} /><ClinicalTimeline records={petRecords} appointments={list.related.appointments} />
          </div>
        </>
      ) : <Pagination {...selectedPet} />}
    </OwnerLayout>
  );
}
