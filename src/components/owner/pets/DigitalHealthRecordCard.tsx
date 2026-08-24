import { Activity, Plus } from "lucide-react";
import { Button } from "../../ui/Button";

export function DigitalHealthRecordCard() {
  const records = [
    {
      id: 1,
      title: "Annual Checkup & Bloodwork",
      date: "Oct 12, 2023",
      badges: ["Medical History", "Normal"],
    },
    {
      id: 2,
      title: "Digital Prescription: NexGard",
      date: "Sep 05, 2023",
      badges: ["Active"],
      active: true,
    }
  ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <Activity className="text-primary" size={24} />
          Digital Health Record
        </h3>
        <button className="text-primary hover:bg-slate-50 p-1.5 rounded-lg transition-colors">
          <Plus size={24} />
        </button>
      </div>

      <div className="space-y-4 mb-6">
        {records.map((record) => (
          <div key={record.id} className="rounded-xl border border-slate-200 p-4 hover:border-primary/50 transition-colors cursor-pointer">
            <div className="flex justify-between items-start mb-3">
              <h4 className="font-semibold text-slate-900">{record.title}</h4>
              <span className="text-sm text-slate-500">{record.date}</span>
            </div>
            <div className="flex gap-2">
              {record.badges.map((badge, idx) => (
                <span 
                  key={idx} 
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md ${
                    record.active && badge === "Active" 
                      ? "bg-blue-50 text-blue-600" 
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {badge}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Button variant="outline" className="w-full">
        View All Records
      </Button>
    </div>
  );
}
