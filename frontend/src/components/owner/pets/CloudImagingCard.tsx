import { FolderUp, ImageOff, X } from "lucide-react";
import { useState } from "react";
import type { MedicalImage } from "../../../types/medicalImage";
import type { Pet } from "../../../types/pet";

type CloudImagingCardProps = { pet: Pet; images: MedicalImage[] };

export function CloudImagingCard({ pet, images }: CloudImagingCardProps) {
  const [activeImage, setActiveImage] = useState<MedicalImage | null>(null);
  const recentImages = [...images].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between mb-6">
        <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <FolderUp className="text-primary" size={24} />
          Cloud Imaging
        </h3>
        <span className="bg-slate-100 text-slate-600 text-xs font-bold px-3 py-1 rounded-full">
          {images.length} {images.length === 1 ? "file" : "files"}
        </span>
      </div>

      {recentImages.length ? (
        <div className="grid gap-4 sm:grid-cols-2 flex-1">
          {recentImages.map((image) => (
            <button key={image.id} type="button" onClick={() => setActiveImage(image)} className="group relative min-h-32 overflow-hidden rounded-xl border border-slate-200 bg-slate-900 text-left">
              <img src={image.imageUrl} alt={image.title} className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100" />
              <div className="absolute inset-x-0 bottom-0 bg-slate-950/75 px-3 py-2">
                <p className="truncate text-sm font-bold text-white">{image.title}</p>
                <p className="text-[11px] text-slate-300">{new Date(image.createdAt).toLocaleDateString()}</p>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex min-h-44 flex-1 flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 px-5 text-center text-slate-500">
          <ImageOff size={32} className="mb-3 text-slate-400" />
          <p className="text-sm font-semibold">No diagnostic images yet</p>
          <p className="mt-1 text-xs leading-5">Images uploaded by the clinic for {pet.name} will appear here.</p>
        </div>
      )}

      {activeImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true" aria-label={activeImage.title}>
          <div className="relative w-full max-w-3xl rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
            <button type="button" onClick={() => setActiveImage(null)} className="absolute right-5 top-5 rounded-lg bg-slate-900/80 p-2 text-white hover:bg-slate-900" aria-label="Close image preview"><X size={18} /></button>
            <img src={activeImage.imageUrl} alt={activeImage.title} className="max-h-[75vh] w-full rounded-lg object-contain" />
            <p className="px-2 pb-1 pt-3 text-sm font-bold text-slate-900">{activeImage.title}</p>
          </div>
        </div>
      )}
    </div>
  );
}
