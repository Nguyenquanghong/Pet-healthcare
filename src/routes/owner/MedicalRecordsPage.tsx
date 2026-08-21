import { useMemo, useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout";
import { RecordList } from "../../components/shared/RecordList";
import { Card } from "../../components/ui/Card";
import { MetricCard } from "../../components/ui/MetricCard";
import { useAppStore } from "../../store/AppStoreProvider";

export function MedicalRecordsPage() {
  const { medicalRecords, ownerPets } = useAppStore();
  const [selectedPetId, setSelectedPetId] = useState(ownerPets[0]?.id ?? "");
  const selectedPet = ownerPets.find((pet) => pet.id === selectedPetId) ?? ownerPets[0];
  const latestRecord = useMemo(
    () => medicalRecords.find((record) => record.petId === selectedPet?.id),
    [medicalRecords, selectedPet?.id],
  );

  return (
    <AppLayout type="owner" title="Hồ sơ y tế chi tiết">
      <div className="grid gap-6 xl:grid-cols-[1.4fr_0.8fr]">
        <Card title="Clinical Timeline">
          <div className="mb-5 flex flex-col gap-3 rounded-2xl bg-slate-50 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-bold text-primary">Chọn thú cưng</p>
              <p className="text-sm text-slate-500">Theo dõi lịch sử khám, chẩn đoán và điều trị.</p>
            </div>
            <select className="rounded-xl border border-slate-200 px-4 py-3" value={selectedPetId} onChange={(event) => setSelectedPetId(event.target.value)}>
              {ownerPets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name} - {pet.breed}</option>)}
            </select>
          </div>
          <RecordList ownerOnly petId={selectedPet?.id} />
        </Card>
        <div className="grid gap-4">
          <MetricCard label="Weight" value={latestRecord?.weightKg ? `${latestRecord.weightKg} kg` : selectedPet?.weightKg ? `${selectedPet.weightKg} kg` : "N/A"} />
          <MetricCard label="Temp" value={latestRecord?.temperatureC ? `${latestRecord.temperatureC}°C` : "N/A"} />
          <MetricCard label="Heart Rate" value={latestRecord?.heartRateBpm ? `${latestRecord.heartRateBpm} bpm` : "N/A"} />
          <Card title="Follow-up">
            <p className="text-sm text-slate-500">{latestRecord?.followUpDate ? `Tái khám vào ${latestRecord.followUpDate}` : "Chưa có lịch tái khám."}</p>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
