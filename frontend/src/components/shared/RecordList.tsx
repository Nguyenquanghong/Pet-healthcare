import { useAppStore } from "../../store/AppStoreProvider";

type RecordListProps = {
  ownerOnly?: boolean;
  petId?: string;
};

export function RecordList({ ownerOnly = false, petId }: RecordListProps) {
  const { currentOwnerId, medicalRecords, pets } = useAppStore();
  const filteredRecords = medicalRecords.filter((record) => {
    if (ownerOnly && record.ownerId !== currentOwnerId) return false;
    if (petId && record.petId !== petId) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      {filteredRecords.map((record) => {
        const pet = pets.find((item) => item.id === record.petId);
        return (
        <div key={record.id} className="rounded-xl bg-slate-50 p-4">
          <p className="text-xs font-bold text-primary">{record.visitDate} · {pet?.name ?? record.petId} · {record.doctorName}</p>
          <h3 className="font-bold">{record.title}</h3>
          <p className="text-sm text-slate-500">{record.diagnosis}</p>
          <p className="mt-2 text-xs text-slate-500">Điều trị: {record.treatment}</p>
        </div>
      );})}
      {filteredRecords.length === 0 && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">Chưa có hồ sơ y tế.</p>}
    </div>
  );
}