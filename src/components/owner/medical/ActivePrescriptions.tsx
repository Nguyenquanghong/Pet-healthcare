import { FileText, Plus } from "lucide-react";

export function ActivePrescriptions() {
  const prescriptions = [
    {
      id: 1,
      name: "Simparica Trio",
      dosage: "1 chewable monthly",
      exp: "Dec 2024",
      refills: 2,
    },
    {
      id: 2,
      name: "Apoquel (16mg)",
      dosage: "1/2 tablet daily (as needed)",
      exp: "N/A",
      refills: 0,
    }
  ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <FileText className="text-primary" size={24} />
          Active Rx
        </h3>
        <button className="text-primary hover:bg-slate-50 p-1.5 rounded-lg transition-colors">
          <Plus size={24} />
        </button>
      </div>

      <div className="space-y-4">
        {prescriptions.map((rx) => (
          <div key={rx.id} className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="p-4 bg-white flex justify-between items-start">
              <div>
                <h4 className="font-bold text-slate-900">{rx.name}</h4>
                <p className="text-sm text-slate-600 mt-1">{rx.dosage}</p>
              </div>
              <div className={`px-2.5 py-1 text-xs font-bold rounded-lg ${rx.refills > 0 ? 'bg-primary text-white' : 'bg-slate-200 text-slate-600'}`}>
                Refill: {rx.refills}
              </div>
            </div>
            <div className="bg-slate-50 px-4 py-3 flex justify-between items-center border-t border-slate-100 text-sm">
              <span className="text-slate-500">Exp: {rx.exp}</span>
              {rx.refills > 0 && (
                <button className="font-bold text-primary hover:underline">Request Refill</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
