import { useState } from "react";
import {
  Download,
  ExternalLink,
  Info,
  Lock,
  Printer,
  QrCode,
  Share2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { Pet } from "../../../types/pet";
import { useAppStore } from "../../../store/AppStoreProvider";

interface SmartQrTokenProps {
  pet?: Pet;
}

export function SmartQrToken({ pet }: SmartQrTokenProps) {
  const { currentOwner } = useAppStore();
  const [mode, setMode] = useState<"public" | "private">("public");
  const [copied, setCopied] = useState(false);

  if (!pet) return null;

  // Determine current origin / base URL for full scannable link
  const origin = window.location.origin;
  const publicRescueUrl = `${origin}/rescue/${pet.id}`;
  const privateMedicalUrl = `${origin}/owner/medical-records?petId=${pet.id}`;

  const currentUrl = mode === "public" ? publicRescueUrl : privateMedicalUrl;

  // Real scannable QR Code image URL via standardized standard QR API
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=12&data=${encodeURIComponent(
    currentUrl
  )}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(currentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handlePrintTag = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <html>
        <head>
          <title>In Thẻ Đeo Cổ — ${pet.name}</title>
          <style>
            body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fff; }
            .tag { width: 260px; border: 3px solid #003f70; border-radius: 24px; padding: 20px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .tag-header { font-size: 14px; font-weight: bold; color: #003f70; text-transform: uppercase; margin-bottom: 4px; }
            .tag-pet { font-size: 22px; font-weight: 900; color: #111; margin: 6px 0; }
            .tag-breed { font-size: 12px; color: #666; margin-bottom: 12px; }
            .tag img { width: 180px; height: 180px; margin: 0 auto; display: block; border-radius: 12px; }
            .tag-footer { font-size: 11px; font-weight: bold; color: #e11d48; margin-top: 12px; }
            .tag-phone { font-size: 14px; font-weight: 800; color: #003f70; margin-top: 4px; }
          </style>
        </head>
        <body>
          <div class="tag">
            <div class="tag-header">Nippon Pet Care</div>
            <div class="tag-pet">${pet.name}</div>
            <div class="tag-breed">${pet.breed} &bull; Chip: ${pet.microchipId || "N/A"}</div>
            <img src="${qrImageUrl}" alt="QR Code" />
            <div class="tag-footer">QUÉT MÃ ĐỂ CỨU HỘ</div>
            <div class="tag-phone">Hotline: ${currentOwner?.phone || "1900 6868"}</div>
          </div>
          <script>
            window.onload = () => { window.print(); window.close(); };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex flex-col items-center">
      <div className="w-full text-center mb-5">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary mb-2">
          <Sparkles size={13} /> Thẻ Smart QR Định Danh
        </div>
        <h3 className="text-xl font-black text-slate-900">Mã QR Định Danh Thông Minh</h3>
        <p className="text-xs text-slate-500 mt-1">
          Mã QR thực tế có thể quét trực tiếp bằng camera điện thoại để cứu hộ hoặc tra cứu bệnh án.
        </p>
      </div>

      {/* Real QR Code Display */}
      <div className="relative aspect-square w-52 rounded-2xl border-2 border-slate-200 bg-white p-3 flex flex-col items-center justify-center mb-5 shadow-xs group">
        <img
          src={qrImageUrl}
          alt={`Mã QR định danh của ${pet.name}`}
          className="w-full h-full object-contain rounded-xl"
        />
        {/* Tiny pet avatar overlay in center */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-lg shadow-md border border-slate-200">
            {pet.species === "cat" ? "🐱" : "🐶"}
          </div>
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="w-full mb-4">
        <div className="flex rounded-xl border border-slate-200 bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setMode("public")}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition ${
              mode === "public"
                ? "bg-white text-slate-900 shadow-xs border border-slate-200"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <ShieldAlert size={14} className={mode === "public" ? "text-rose-600" : ""} />
            Public (Cứu hộ)
          </button>
          <button
            type="button"
            onClick={() => setMode("private")}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition ${
              mode === "private"
                ? "bg-white text-slate-900 shadow-xs border border-slate-200"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Lock size={14} className={mode === "private" ? "text-primary" : ""} />
            Private (Bác sĩ)
          </button>
        </div>

        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-600 font-medium">
          <Info size={14} className="text-primary" />
          <span>
            {mode === "public"
              ? "Người nhặt được quét mã sẽ thấy SĐT và địa chỉ của bạn."
              : "Bác sĩ thú y quét mã để mở nhanh hồ sơ bệnh án."}
          </span>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="w-full grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
        <a
          href={publicRescueUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-100 transition"
        >
          <ExternalLink size={13} /> Thử quét cứu hộ
        </a>

        <button
          type="button"
          onClick={handlePrintTag}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-xs font-bold text-white shadow-soft hover:bg-primary-dark transition"
        >
          <Printer size={13} /> In thẻ đeo cổ
        </button>

        <a
          href={qrImageUrl}
          download={`QR_${pet.name}.png`}
          target="_blank"
          rel="noreferrer"
          className="col-span-2 flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 transition"
        >
          <Download size={13} /> Tải ảnh mã QR về máy
        </a>
      </div>
    </div>
  );
}
