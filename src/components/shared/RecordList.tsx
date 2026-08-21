import { records } from "../../data/mockData";

export function RecordList() {
  return (
    <div className="space-y-3">
      {records.map((record) => (
        <div key={record.title} className="rounded-xl bg-slate-50 p-4">
          <p className="text-xs font-bold text-primary">{record.date} · {record.pet}</p>
          <h3 className="font-bold">{record.title}</h3>
          <p className="text-sm text-slate-500">{record.note}</p>
        </div>
      ))}
    </div>
  );
}