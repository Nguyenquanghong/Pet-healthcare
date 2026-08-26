import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Building,
  CheckCircle2,
  Heart,
  Mail,
  MapPin,
  Phone,
  QrCode,
  Send,
  ShieldCheck,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";
import { useAppStore } from "../../store/AppStoreProvider";

type RescueFormErrors = Partial<Record<"finderPhone" | "location", string>>;

const genderLabels = {
  male: "Đực",
  female: "Cái",
  unknown: "Chưa rõ",
};

export function PetRescuePage() {
  const { qrToken } = useParams<{ qrToken: string }>();
  const { pets, owners, submitRescueReport } = useAppStore();
  const [finderName, setFinderName] = useState("");
  const [finderPhone, setFinderPhone] = useState("");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<RescueFormErrors>({});
  const [sent, setSent] = useState(false);

  const pet = useMemo(
    () => pets.find((item) => item.qrToken === qrToken) ?? pets.find((item) => item.id === qrToken),
    [pets, qrToken],
  );
  const owner = owners.find((item) => item.id === pet?.ownerId);
  const publicProfile = pet?.publicProfile ?? {
    showOwnerPhone: true,
    showOwnerEmail: false,
    showOwnerAddress: false,
    showMedicalAlerts: true,
  };
  const qrUnavailable = !pet || pet.qrEnabled === false;

  const validate = () => {
    const nextErrors: RescueFormErrors = {};
    if (!finderPhone.trim()) nextErrors.finderPhone = "Vui lòng nhập số điện thoại để chủ nuôi có thể liên hệ.";
    if (!location.trim()) nextErrors.location = "Vui lòng nhập vị trí bạn đã tìm thấy thú cưng.";
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pet || !validate()) return;

    submitRescueReport({
      petId: pet.id,
      finderName: finderName.trim() || undefined,
      finderPhone: finderPhone.trim(),
      location: location.trim(),
      note: note.trim() || undefined,
    });
    setSent(true);
    setFinderName("");
    setFinderPhone("");
    setLocation("");
    setNote("");
  };

  if (qrUnavailable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <QrCode size={48} className="mx-auto mb-4 text-slate-300" />
          <h1 className="mb-2 text-xl font-bold text-slate-900">QR cứu hộ không khả dụng</h1>
          <p className="mb-6 text-sm leading-6 text-slate-500">
            Mã QR này không tồn tại, đã bị tạm khóa hoặc đã được thay bằng mã mới.
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white shadow-soft"
          >
            <ArrowLeft size={16} /> Về trang chủ
          </Link>
        </div>
      </div>
    );
  }

  const medicalAlerts = pet.allergies?.filter((item) => item.toLowerCase() !== "không") ?? [];

  return (
    <div className="min-h-screen bg-slate-100 p-4 sm:p-6">
      <div className="mx-auto w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
        <section className="bg-gradient-to-r from-rose-600 to-amber-600 p-6 text-white sm:p-8">
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-black uppercase tracking-wide backdrop-blur-xs">
            <AlertTriangle size={14} /> Pet rescue QR
          </div>
          <h1 className="text-3xl font-black sm:text-4xl">Xin chào, mình là {pet.name}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/90">
            Nếu bạn đang đọc trang này, có thể mình đang đi lạc. Vui lòng giữ mình an toàn và liên hệ chủ nuôi.
          </p>
        </section>

        <div className="grid gap-0 lg:grid-cols-[1fr_0.9fr]">
          <section className="space-y-5 p-6 sm:p-8">
            <div className="flex items-center gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white text-4xl shadow-xs">
                {pet.avatarUrl ? (
                  <img src={pet.avatarUrl} alt={pet.name} className="h-full w-full object-cover" />
                ) : (
                  <>{pet.species === "cat" ? "🐱" : pet.species === "rabbit" ? "🐰" : pet.species === "dog" ? "🐶" : "🐾"}</>
                )}
              </div>
              <div>
                <h2 className="text-2xl font-black text-slate-900">{pet.name}</h2>
                <p className="mt-1 text-sm font-semibold text-slate-600">
                  {pet.breed} • {pet.ageLabel} • {genderLabels[pet.gender]}
                </p>
                {pet.microchipId && <p className="mt-1 text-xs font-bold text-primary">Microchip: {pet.microchipId}</p>}
              </div>
            </div>

            {publicProfile.rescueNote && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-black text-amber-900">Lời nhắn từ chủ nuôi</p>
                <p className="mt-1 text-sm leading-6 text-amber-800">{publicProfile.rescueNote}</p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {pet.identifyingMarks && (
                <div className="rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs font-black uppercase tracking-wider text-slate-500">Đặc điểm nhận dạng</p>
                  <p className="mt-2 text-sm font-semibold text-slate-800">{pet.identifyingMarks}</p>
                </div>
              )}
              {pet.lastSeenLocation && (
                <div className="rounded-2xl border border-slate-200 p-4">
                  <p className="text-xs font-black uppercase tracking-wider text-slate-500">Khu vực quen thuộc</p>
                  <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <MapPin size={15} className="text-primary" /> {pet.lastSeenLocation}
                  </p>
                </div>
              )}
            </div>

            {publicProfile.showMedicalAlerts && medicalAlerts.length > 0 && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                <div className="mb-1 flex items-center gap-2 text-sm font-bold text-rose-800">
                  <AlertTriangle size={16} /> Cảnh báo y tế
                </div>
                <p className="text-sm font-medium text-rose-700">
                  Dị ứng / lưu ý: <strong>{medicalAlerts.join(", ")}</strong>. Vui lòng không cho thú cưng ăn đồ lạ.
                </p>
              </div>
            )}

            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-primary">Liên hệ chủ nuôi</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-slate-900">{owner?.fullName ?? "Chủ nuôi"}</span>
                  <span className="text-xs text-slate-500">Owner</span>
                </div>

                {publicProfile.showOwnerAddress && owner?.address && (
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <MapPin size={15} className="shrink-0 text-slate-400" />
                    <span>{owner.address}</span>
                  </div>
                )}

                {publicProfile.showOwnerPhone && owner?.phone && (
                  <a
                    href={`tel:${owner.phone}`}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 py-3.5 text-sm font-black text-white shadow-soft transition-colors hover:bg-emerald-700"
                  >
                    <Phone size={18} /> Gọi cho chủ nuôi ({owner.phone})
                  </a>
                )}

                {publicProfile.showOwnerEmail && owner?.email && (
                  <a
                    href={`mailto:${owner.email}`}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
                  >
                    <Mail size={17} /> Gửi email
                  </a>
                )}
              </div>
            </div>

            <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
              <div className="flex items-center gap-2 font-bold text-slate-800">
                <Building size={16} className="text-primary" />
                Hỗ trợ bởi NIPOPETO
              </div>
              <p className="text-[11px] text-slate-500">
                Nếu chưa liên hệ được với chủ nuôi, vui lòng gọi hotline để được hướng dẫn giữ thú cưng an toàn.
              </p>
              <a href="tel:19006868" className="inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline">
                <Phone size={13} /> Hotline: 1900 6868
              </a>
            </div>
          </section>

          <section className="border-t border-slate-200 bg-slate-50 p-6 sm:p-8 lg:border-l lg:border-t-0">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck size={20} className="text-primary" />
                <h2 className="text-lg font-black text-slate-900">Báo đã tìm thấy pet</h2>
              </div>
              <p className="mb-5 text-sm leading-6 text-slate-500">
                Thông tin này sẽ được gửi riêng cho chủ nuôi trong hệ thống. Không cần đăng nhập.
              </p>

              {sent ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
                  <CheckCircle2 size={34} className="mx-auto mb-3 text-emerald-600" />
                  <h3 className="font-black text-emerald-900">Đã gửi thông tin cho chủ nuôi</h3>
                  <p className="mt-2 text-sm leading-6 text-emerald-700">
                    Cảm ơn bạn đã giúp đỡ. Chủ nuôi sẽ nhận được vị trí và số điện thoại liên hệ của bạn.
                  </p>
                  <Button type="button" variant="outline" className="mt-4" onClick={() => setSent(false)}>
                    Gửi cập nhật khác
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate className="space-y-4">
                  <Input
                    label="Tên của bạn"
                    value={finderName}
                    onChange={(event) => setFinderName(event.target.value)}
                    placeholder="Ví dụ: Anh Minh"
                  />
                  <Input
                    label="Số điện thoại liên hệ *"
                    value={finderPhone}
                    onChange={(event) => setFinderPhone(event.target.value)}
                    placeholder="Ví dụ: 0901234567"
                    error={errors.finderPhone}
                  />
                  <Input
                    label="Vị trí tìm thấy *"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="Ví dụ: Công viên Cầu Giấy, Hà Nội"
                    error={errors.location}
                  />
                  <Textarea
                    label="Ghi chú thêm"
                    rows={4}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Tình trạng pet, bạn đang giữ ở đâu, thời điểm tìm thấy..."
                  />
                  <Button type="submit" icon={<Send size={16} />} className="w-full">
                    Gửi cho chủ nuôi
                  </Button>
                </form>
              )}
            </div>
          </section>
        </div>

        <div className="border-t border-slate-800 bg-slate-900 p-4 text-center text-xs text-slate-400">
          <p className="flex items-center justify-center gap-1">
            Hệ sinh thái Quản lý Thú cưng Thông minh <Heart size={12} className="fill-rose-500 text-rose-500" /> NIPOPETO
          </p>
        </div>
      </div>
    </div>
  );
}
