import { Activity, CalendarDays, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../ui/Button";
import type { MedicalRecord } from "../../../types/medicalRecord";
import type { Pet } from "../../../types/pet";

type DigitalHealthRecordCardProps = { pet: Pet; records: MedicalRecord[] };

export function DigitalHealthRecordCard({ pet, records }: DigitalHealthRecordCardProps) {
  const recentRecords = [...records].sort((a, b) => b.visitDate.localeCompare(a.visitDate)).slice(0, 2);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <Activity className="text-primary" size={24} />
          Digital Health Record
        </h3>
      </div>

      {recentRecords.length ? (
        <div className="space-y-4 mb-6">
          {recentRecords.map((record) => (
            <Link key={record.id} to={`/owner/medical-records?petId=${pet.id}`} className="block rounded-xl border border-slate-200 p-4 transition-colors hover:border-primary/50 hover:bg-slate-50">
              <div className="flex justify-between gap-3 items-start mb-3">
                <h4 className="font-semibold text-slate-900">{record.title}</h4>
                <span className="shrink-0 text-sm text-slate-500">{record.visitDate}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-100 text-slate-600">Medical record</span>
                {record.vaccineName && <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-blue-50 text-blue-700">Vaccination</span>}
                {record.followUpDate && <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-amber-50 text-amber-700">Follow-up scheduled</span>}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="mb-6 flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center">
          <FileText size={25} className="mb-2 text-slate-400" />
          <p className="text-sm font-semibold text-slate-700">No medical records yet</p>
          <p className="mt-1 text-xs text-slate-500">Records added by the clinic will appear here.</p>
        </div>
      )}

      <Link to={`/owner/medical-records?petId=${pet.id}`} className="block">
        <Button variant="outline" icon={<CalendarDays size={16} />} className="w-full">View all records</Button>
      </Link>
    </div>
  );
}
