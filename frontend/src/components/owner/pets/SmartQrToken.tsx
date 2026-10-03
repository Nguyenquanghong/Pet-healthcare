import { useEffect, useState } from "react";
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
import { printRescueTag } from "./printRescueTag";

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

export function SmartQrToken({ pet }: SmartQrTokenProps) {
  const { currentOwner, updatePet, rotatePetQrToken } = useAppStore();
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [rescueNote, setRescueNote] = useState(pet?.publicProfile?.rescueNote ?? "");
  const [noteDirty, setNoteDirty] = useState(false);
  useEffect(() => {
    if (!noteDirty) setRescueNote(pet?.publicProfile?.rescueNote ?? "");
  }, [pet?.publicProfile?.rescueNote, noteDirty]);

  if (!pet) return null;

  const origin = window.location.origin;
  const qrToken = pet.qrToken;
  // Keep the public QR on the site root so static hosts can serve it without
  // requiring a server-side SPA rewrite for deep links.
  const publicRescueUrl = qrToken ? `${origin}/?rescue=${encodeURIComponent(qrToken)}` : "";
  const qrImageUrl = qrToken ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=12&data=${encodeURIComponent(
    publicRescueUrl,
  )}` : "";
  const publicProfile = pet.publicProfile ?? {
    showOwnerPhone: true,
    showOwnerEmail: false,
    showOwnerAddress: false,
    showMedicalAlerts: true,
  };

  const save = async (operation: () => Promise<boolean>) => {
    setSaving(true); setFeedback("");
    try {
      const refreshed = await operation();
      setFeedback(refreshed ? "Đã lưu thay đổi." : "Đã lưu nhưng chưa tải lại được dữ liệu. Hãy tải lại để đối chiếu.");
      return true;
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "Không thể lưu thay đổi.");
      return false;
    } finally { setSaving(false); }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicRescueUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch { setFeedback("Không thể sao chép. Hãy mở trang public để lấy liên kết."); }
  };

  const updatePublicProfile = (input: Partial<PetPublicProfile>) =>
    save(() => updatePet(pet.id, { publicProfile: input }));

  const handleRegenerateToken = () => save(() => rotatePetQrToken(pet.id));

  const handlePrintTag = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) { setFeedback("Cho phép cửa sổ bật lên để in thẻ QR."); return; }
    printWindow.opener = null;
    printRescueTag(printWindow, { name: pet.name, breed: pet.breed,
      phone: publicProfile.showOwnerPhone ? currentOwner?.phone || "1900 6868" : "1900 6868", qrImageUrl });
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
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
          {!qrToken ? "Chưa có mã" : pet.qrEnabled === false ? "Paused" : "Active"}
        </span>
      </div>

      <div className="flex flex-col items-center">
        <div className="relative mb-5 flex aspect-square w-48 items-center justify-center rounded-lg border border-slate-200 bg-white p-3">
          {qrToken ? <img src={qrImageUrl} alt={`Mã QR cứu hộ của ${pet.name}`} className="h-full w-full rounded-xl object-contain" /> : <p className="text-sm text-slate-500">Tạo mã QR để chia sẻ hồ sơ cứu hộ.</p>}
          {pet.qrEnabled === false && (
            <div className="absolute inset-3 flex items-center justify-center rounded-xl bg-white/90 text-sm font-black text-slate-500">
              QR đang tạm khóa
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-slate-100 pb-4">
        <button
          type="button"
          onClick={handleCopyLink}
          disabled={!qrToken || saving}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
        >
          <Copy size={13} /> {copied ? "Đã copy" : "Copy link"}
        </button>
        <a
          href={qrToken ? publicRescueUrl : undefined}
          aria-disabled={!qrToken}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50"
        >
          <ExternalLink size={13} /> Xem trang public
        </a>
        <button
          type="button"
          onClick={handlePrintTag}
          disabled={!qrToken || saving}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary py-2.5 text-xs font-semibold text-white transition-colors hover:bg-primary-dark"
        >
          <Printer size={13} /> In thẻ QR
        </button>
        <a
          href={qrToken ? qrImageUrl : undefined}
          aria-disabled={!qrToken}
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
          onClick={() => save(() => updatePet(pet.id, { qrEnabled: pet.qrEnabled === false }))}
          disabled={saving || !qrToken}
          className="w-full"
        >
          {pet.qrEnabled === false ? "Bật lại QR cứu hộ" : "Tạm khóa QR cứu hộ"}
        </Button>

        <Button type="button" variant="outline" icon={<RefreshCw size={15} />} onClick={handleRegenerateToken} disabled={saving} className="w-full">
          {qrToken ? "Đổi mã QR mới" : "Tạo mã QR"}
        </Button>
      </div>

      <div className="mt-5 border-l-2 border-amber-400 bg-amber-50 p-4">
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
                disabled={saving}
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
          value={rescueNote}
          disabled={saving}
          maxLength={10_000}
          onChange={(event) => { setRescueNote(event.target.value); setNoteDirty(true); }}
          placeholder="Ví dụ: Bé hơi nhát, vui lòng không đuổi theo..."
        />
        <Button className="mt-3" disabled={saving || !noteDirty} onClick={async () => {
          if (await updatePublicProfile({ rescueNote })) setNoteDirty(false);
        }}>Lưu lời nhắn</Button>
      </div>
      {feedback && <p role="status" className="mt-3 text-sm text-slate-700">{feedback}</p>}
    </div>
  );
}
