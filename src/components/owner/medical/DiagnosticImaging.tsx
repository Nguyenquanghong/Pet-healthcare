import { Image as ImageIcon, Maximize2, UploadCloud } from "lucide-react";

export function DiagnosticImaging() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <ImageIcon className="text-primary" size={24} />
          Diagnostic Imaging
        </h3>
        <button className="text-slate-500 hover:text-primary transition-colors">
          <UploadCloud size={20} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="rounded-xl overflow-hidden relative group cursor-pointer bg-slate-900 border border-slate-200 aspect-square">
          <img 
            src="https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=500&auto=format&fit=crop&q=60" 
            alt="X-Ray 1" 
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity mix-blend-luminosity" 
          />
          <button className="absolute top-2 right-2 bg-black/50 text-white p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
            <Maximize2 size={16} />
          </button>
        </div>
        <div className="rounded-xl overflow-hidden relative group cursor-pointer bg-slate-900 border border-slate-200 aspect-square">
          <img 
            src="https://images.unsplash.com/photo-1579684385127-1ef15d508118?w=500&auto=format&fit=crop&q=60" 
            alt="Ultrasound" 
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity mix-blend-luminosity" 
          />
        </div>
      </div>
      
      <button className="w-full mt-auto rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 hover:bg-slate-50/70 hover:border-primary text-slate-500 hover:text-primary transition-colors py-6 flex flex-col items-center justify-center gap-2">
        <UploadCloud size={24} />
        <span className="font-semibold text-sm">Upload New DICOM</span>
      </button>
    </div>
  );
}
