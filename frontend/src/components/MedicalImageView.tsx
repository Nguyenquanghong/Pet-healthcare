import { ImageOff } from "lucide-react";
import { useState } from "react";
import type { MedicalImage } from "../types/medicalImage";

// Shows a medical image through its valet key. An expired key fails to load; the
// caller then reloads the list, which hands out fresh keys. A key that is still
// valid but fails (missing object) only shows the placeholder, so there is no loop.
export function MedicalImageView({ image, className, onExpired }: { image: MedicalImage; className?: string; onExpired?: () => void }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!image.url || failedUrl === image.url) {
    return (
      <div className={`flex flex-col items-center justify-center gap-1 bg-slate-100 text-slate-400 ${className ?? ""}`} role="img" aria-label={image.title}>
        <ImageOff size={20} />
        <span className="px-2 text-center text-[11px] font-semibold">Ảnh chưa sẵn sàng</span>
      </div>
    );
  }
  return (
    <img src={image.url} alt={image.title} className={className} onError={() => {
      setFailedUrl(image.url);
      if (image.urlExpiresAt && Date.parse(image.urlExpiresAt) <= Date.now() + 5000) onExpired?.();
    }} />
  );
}
