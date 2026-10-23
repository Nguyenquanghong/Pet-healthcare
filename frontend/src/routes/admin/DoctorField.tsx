import { useEffect, useState } from "react";
import { apiClient } from "../../services/apiClient";
import { useSession } from "../../store/SessionContext";
import type { ApiSchemas } from "../../types/generated/api";

type Doctor = ApiSchemas["DoctorList"]["items"][number];

// P11: the server decides who signs a medical record. Only an admin
// (medical-record.assign-doctor) picks the responsible doctor; any other writer
// signs as themself and only sees their own name.
export function useSignsAsSelf() {
  return !useSession().can("medical-record.assign-doctor");
}

export function DoctorField({ value, onChange, className }: { value: string; onChange: (id: string) => void; className: string }) {
  const { user } = useSession();
  const self = useSignsAsSelf();
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (self) return;
    let active = true;
    apiClient.get<{ items: Doctor[] }>("/doctors").then(
      ({ items }) => { if (active) setDoctors(items); },
      (reason) => { if (active) setError(reason instanceof Error ? reason.message : "Không tải được danh sách bác sĩ."); },
    );
    return () => { active = false; };
  }, [self]);
  if (self) return <p className={`${className} bg-slate-50`}>{user?.fullName}</p>;
  return (
    <>
      <select aria-label="Bác sĩ phụ trách" className={className} value={value} onChange={(e) => onChange(e.target.value)} disabled={!doctors}>
        <option value="">{doctors ? "Chọn bác sĩ" : "Đang tải danh sách bác sĩ..."}</option>
        {doctors?.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.fullName}</option>)}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}
    </>
  );
}
