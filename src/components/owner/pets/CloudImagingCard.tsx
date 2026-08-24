import { FolderUp, UploadCloud } from "lucide-react";

export function CloudImagingCard() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <FolderUp className="text-primary" size={24} />
          Cloud Imaging
        </h3>
        <span className="bg-slate-100 text-slate-600 text-xs font-bold px-3 py-1 rounded-full">
          2 Files
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 flex-1">
        <div className="rounded-xl overflow-hidden relative group cursor-pointer bg-slate-900 border border-slate-200">
          <img 
            src="https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=500&auto=format&fit=crop&q=60" 
            alt="X-Ray" 
            className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity mix-blend-luminosity" 
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent"></div>
          <p className="absolute bottom-3 left-3 text-white text-sm font-bold z-10">Chest X-Ray</p>
        </div>
        
        <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 flex flex-col items-center justify-center text-slate-400 hover:text-primary hover:border-primary hover:bg-slate-50/50 transition-colors cursor-pointer min-h-32">
          <UploadCloud size={32} className="mb-2" />
          <span className="text-sm font-semibold">Upload Scan</span>
        </div>
      </div>
    </div>
  );
}
