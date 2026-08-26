import { Activity, ArrowDown } from "lucide-react";
import type { MedicalRecord } from "../../../types/medicalRecord";
import type { Pet } from "../../../types/pet";

const statusLabels = {
  healthy: "Khỏe mạnh",
  stable: "Ổn định",
  vaccination_due: "Cần tiêm phòng",
  under_treatment: "Đang điều trị",
  critical: "Cần theo dõi sát",
};

interface PetVitalsSummaryProps {
  pet: Pet;
  latestRecord?: MedicalRecord;
}

export function PetVitalsSummary({ pet, latestRecord }: PetVitalsSummaryProps) {
  return (
    <div className="flex items-center justify-between gap-6 overflow-x-auto rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex-1 min-w-max">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Weight</p>
        <p className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-900">
          {latestRecord?.weightKg ?? pet.weightKg ?? "—"} kg {(latestRecord?.weightKg || pet.weightKg) && <ArrowDown size={18} className="text-emerald-500" />}
        </p>
      </div>
      
      <div className="w-px h-12 bg-slate-200 hidden sm:block"></div>
      
      <div className="flex-1 min-w-max">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Temp</p>
        <p className="mt-1 text-xl font-semibold text-slate-900">{latestRecord?.temperatureC ? `${latestRecord.temperatureC}°C` : "—"}</p>
      </div>
      
      <div className="w-px h-12 bg-slate-200 hidden sm:block"></div>
      
      <div className="flex-1 min-w-max">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Heart Rate</p>
        <p className="mt-1 text-xl font-semibold text-slate-900">{latestRecord?.heartRateBpm ? `${latestRecord.heartRateBpm} bpm` : "—"}</p>
      </div>
      
      <div className="w-px h-12 bg-slate-200 hidden sm:block"></div>
      
      <div className="flex-1 min-w-max">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Status</p>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1 text-sm font-semibold text-emerald-700">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-500"></div>
          {statusLabels[pet.healthStatus]}
        </div>
        {latestRecord && <p className="mt-1 flex items-center gap-1 text-xs text-slate-400"><Activity size={12} /> Cập nhật {latestRecord.visitDate}</p>}
      </div>
    </div>
  );
}
