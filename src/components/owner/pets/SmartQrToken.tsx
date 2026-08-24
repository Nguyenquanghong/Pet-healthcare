import { Info, QrCode } from "lucide-react";

export function SmartQrToken() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex flex-col items-center">
      <div className="w-full text-center mb-6">
        <h3 className="text-xl font-bold text-slate-900">Smart QR Token</h3>
        <p className="text-sm text-slate-500 mt-2">
          Scan for emergency info or medical records based on active mode.
        </p>
      </div>
      
      <div className="aspect-square w-48 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-center mb-8">
        <QrCode size={100} className="text-slate-800" strokeWidth={1} />
      </div>
      
      <div className="w-full">
        <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1 mb-4">
          <button className="flex-1 rounded-md bg-white py-2 text-sm font-bold text-slate-900 shadow-sm border border-slate-200">
            Public Mode
          </button>
          <button className="flex-1 rounded-md py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">
            Private Mode
          </button>
        </div>
        
        <div className="flex items-center justify-center gap-2 text-sm text-primary font-medium">
          <Info size={16} />
          <span>Currently showing: Contact Info</span>
        </div>
      </div>
    </div>
  );
}
