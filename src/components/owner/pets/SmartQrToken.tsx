import { useState } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Printer,
  QrCode,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import type { Pet, PetPublicProfile } from "../../../types/pet";
import { useAppStore } from "../../../store/AppStoreProvider";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Textarea";

interface SmartQrTokenProps {
  pet?: Pet;
}

const publicProfileOptions: Array<{
  key: keyof Pick<PetPublicProfile, "showOwnerPhone" | "showOwnerEmail" | "showOwnerAddress" | "showMedicalAlerts">;
  label: string;
  description: string;
}> = [
  { key: "showOwnerPhone", label: "Hiện số điện thoại", description: "Người nhặt pet có thể gọi trực tiếp cho bạn." },
  { key: "showOwnerEmail", label: "Hiện email", description: "Dùng khi bạn muốn nhận liên hệ bằng email." },
  { key: "showOwnerAddress", label: "Hiện địa chỉ", description: "Chỉ bật nếu thật sự cần công khai khu vực." },
  { key: "showMedicalAlerts", label: "Hiện cảnh báo y tế", description: "Hiển thị dị ứng và lưu ý chăm sóc quan trọng." },
];

function createQrToken(petId: string) {
  return `${petId}_${Math.random().toString(36).slice(2, 10)}`;
}

export function SmartQrToken({ pet }: SmartQrTokenProps) {
  const { currentOwner, updatePet } = useAppStore();
  const [copied, setCopied] = useState(false);

  if (!pet) return null;

  const origin = window.location.origin;
  const qrToken = pet.qrToken ?? pet.id;
  const publicRescueUrl = `${origin}/rescue/${qrToken}`;
  const privateMedicalUrl = `${origin}/owner/medical-records?petId=${pet.id}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=12&data=${encodeURIComponent(
    publicRescueUrl,
  )}`;
  const publicProfile = pet.publicProfile ?? {
    showOwnerPhone: true,
    showOwnerEmail: false,
    showOwnerAddress: false,
    showMedicalAlerts: true,
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(publicRescueUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  const updatePublicProfile = (input: Partial<PetPublicProfile>) => {
    updatePet(pet.id, { publicProfile: { ...publicProfile, ...input } });
  };

  const handleRegenerateToken = () => {
    updatePet(pet.id, { qrToken: createQrToken(pet.id), qrEnabled: true });
  };

  const handlePrintTag = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <html>
        <head>
          <title>In thẻ cứu hộ - ${pet.name}</title>
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
            <div class="tag-header">NIPOPETO</div>
            <div class="tag-pet">${pet.name}</div>
            <div class="tag-breed">${pet.breed}</div>
            <img src="${qrImageUrl}" alt="QR Code" />
            <div class="tag-footer">QUÉT MÃ ĐỂ BÁO TÌM THẤY</div>
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
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
            <QrCode size={13} /> QR Rescue Profile
          </div>
          <h3 className="text-xl font-black text-slate-900">Hồ sơ cứu hộ công khai</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Người lạ quét QR chỉ thấy thông tin bạn cho phép và có thể gửi vị trí tìm thấy.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-black ${
            pet.qrEnabled === false ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {pet.qrEnabled === false ? "Paused" : "Active"}
        </span>
      </div>

      <div className="flex flex-col items-center">
        <div className="relative mb-5 flex aspect-square w-52 items-center justify-center rounded-2xl border-2 border-slate-200 bg-white p-3 shadow-xs">
          <img src={qrImageUrl} alt={`Mã QR cứu hộ của ${pet.name}`} className="h-full w-full rounded-xl object-contain" />
          {pet.qrEnabled === false && (
            <div className="absolute inset-3 flex items-center justify-center rounded-xl bg-white/90 text-sm font-black text-slate-500">
              QR đang tạm khóa
            </div>
          )}
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="break-all text-xs font-semibold text-slate-600">{publicRescueUrl}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-slate-100 pb-4">
        <button
          type="button"
          onClick={handleCopyLink}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
        >
          <Copy size={13} /> {copied ? "Đã copy" : "Copy link"}
        </button>
        <a
          href={publicRescueUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
        >
          <ExternalLink size={13} /> Xem trang public
        </a>
        <button
          type="button"
          onClick={handlePrintTag}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-xs font-bold text-white shadow-soft transition hover:bg-primary-dark"
        >
          <Printer size={13} /> In thẻ QR
        </button>
        <a
          href={qrImageUrl}
          download={`QR_${pet.name}.png`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
        >
          <Download size={13} /> Tải QR
        </a>
      </div>

      <div className="mt-4 space-y-3">
        <Button
          type="button"
          variant={pet.qrEnabled === false ? "primary" : "outline"}
          icon={pet.qrEnabled === false ? <Eye size={15} /> : <EyeOff size={15} />}
          onClick={() => updatePet(pet.id, { qrEnabled: pet.qrEnabled === false })}
          className="w-full"
        >
          {pet.qrEnabled === false ? "Bật lại QR cứu hộ" : "Tạm khóa QR cứu hộ"}
        </Button>

        <Button type="button" variant="outline" icon={<RefreshCw size={15} />} onClick={handleRegenerateToken} className="w-full">
          Đổi mã QR mới
        </Button>
      </div>

      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-amber-900">
          <ShieldAlert size={16} />
          Thông tin hiển thị khi quét QR
        </div>
        <div className="space-y-3">
          {publicProfileOptions.map((option) => (
            <label key={option.key} className="flex items-start gap-3 rounded-xl bg-white/70 p-3">
              <input
                type="checkbox"
                checked={Boolean(publicProfile[option.key])}
                onChange={(event) => updatePublicProfile({ [option.key]: event.target.checked })}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
              />
              <span>
                <span className="block text-sm font-bold text-slate-900">{option.label}</span>
                <span className="text-xs leading-5 text-slate-500">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        <Textarea
          className="mt-3"
          label="Lời nhắn cứu hộ"
          rows={3}
          value={publicProfile.rescueNote ?? ""}
          onChange={(event) => updatePublicProfile({ rescueNote: event.target.value })}
          placeholder="Ví dụ: Bé hơi nhát, vui lòng không đuổi theo..."
        />
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        Trang riêng cho bác sĩ vẫn giữ trong hệ thống nội bộ: <span className="font-semibold text-slate-900">{privateMedicalUrl}</span>
      </div>
    </div>
  );
}
