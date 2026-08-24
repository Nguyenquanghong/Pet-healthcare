import { useParams, Link } from "react-router-dom";
import {
  Phone,
  MapPin,
  AlertTriangle,
  Heart,
  ShieldCheck,
  Building,
  QrCode,
  ArrowLeft,
} from "lucide-react";
import { useAppStore } from "../../store/AppStoreProvider";

export function PetRescuePage() {
  const { petId } = useParams<{ petId: string }>();
  const { pets, owners } = useAppStore();

  const pet = pets.find((p) => p.id === petId) ?? pets[0];
  const owner = owners.find((o) => o.id === pet?.ownerId) ?? owners[0];

  if (!pet) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full text-center bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
          <QrCode size={48} className="mx-auto text-slate-300 mb-4" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">Không tìm thấy thú cưng</h1>
          <p className="text-sm text-slate-500 mb-6">
            Mã định danh thú cưng này không tồn tại trong hệ thống.
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

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4 sm:p-6">
      {/* Container */}
      <div className="w-full max-w-lg bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden animate-scaleUp">
        {/* Urgent Rescue Header */}
        <div className="bg-gradient-to-r from-rose-600 to-amber-600 p-6 text-white text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-black tracking-wide uppercase mb-3 backdrop-blur-xs">
            <AlertTriangle size={14} /> Thẻ Định Danh Khẩn Cấp — Cứu Hộ Thú Cưng
          </div>
          <h1 className="text-2xl sm:text-3xl font-black">Xin chào, mình là {pet.name}!</h1>
          <p className="text-xs sm:text-sm text-white/90 mt-1">
            Nếu bạn đang đọc thông tin này, có thể mình đang bị thất lạc. Vui lòng liên hệ với chủ nuôi của mình nhé!
          </p>
        </div>

        {/* Pet Basic Details */}
        <div className="p-6 space-y-6">
          {/* Avatar & Species Info */}
          <div className="flex items-center gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-100">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white text-3xl shadow-xs border border-slate-200">
              {pet.species === "cat" ? "🐈" : pet.species === "dog" ? "🐕" : "🐾"}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-black text-slate-900">{pet.name}</h2>
                <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
                  {pet.gender === "male" ? "Đực ♂" : pet.gender === "female" ? "Cái ♀" : "Chưa rõ"}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-semibold mt-0.5">
                {pet.breed} &bull; {pet.ageLabel} &bull; {pet.weightKg ? `${pet.weightKg} kg` : ""}
              </p>
              {pet.microchipId && (
                <p className="text-[11px] font-bold text-slate-700 mt-1">
                  Mã Microchip: <span className="font-mono text-primary">{pet.microchipId}</span>
                </p>
              )}
            </div>
          </div>

          {/* Allergy & Medical Warning */}
          {pet.allergies && pet.allergies.length > 0 && pet.allergies[0] !== "Không" && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
              <div className="flex items-center gap-2 font-bold text-rose-800 text-sm mb-1">
                <AlertTriangle size={16} /> Cảnh báo dị ứng & Chăm sóc đặc biệt:
              </div>
              <p className="text-xs text-rose-700 font-medium">
                Bé bị dị ứng với: <strong>{pet.allergies.join(", ")}</strong>. Vui lòng không cho bé ăn các loại thực phẩm này!
              </p>
            </div>
          )}

          {/* Owner Emergency Contact */}
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-primary mb-3">
              Thông tin Chủ nuôi
            </h3>
            
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-900">{owner.fullName}</span>
                <span className="text-xs text-slate-500">Chủ thú cưng</span>
              </div>

              <div className="flex items-center gap-2 text-xs text-slate-600">
                <MapPin size={15} className="text-slate-400 shrink-0" />
                <span>{owner.address || "Khu vực Hà Nội"}</span>
              </div>

              {/* Call Button */}
              <a
                href={`tel:${owner.phone}`}
                className="mt-3 flex items-center justify-center gap-2 w-full rounded-2xl bg-emerald-600 py-3.5 text-sm font-black text-white shadow-soft hover:bg-emerald-700 transition-colors"
              >
                <Phone size={18} /> GỌI NGAY CHO CHỦ NUÔI ({owner.phone})
              </a>
            </div>
          </div>

          {/* Nippon Pet Care Clinic Assistance */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 space-y-2">
            <div className="flex items-center gap-2 font-bold text-slate-800">
              <Building size={16} className="text-primary" />
              Bệnh viện Thú y bảo trợ: Nippon Pet Care
            </div>
            <p className="text-[11px] text-slate-500">
              Nếu bạn không liên hệ được với chủ nuôi, vui lòng liên hệ Hotline bệnh viện để được hỗ trợ tiếp nhận và bảo quản thú cưng an toàn.
            </p>
            <a
              href="tel:19006868"
              className="inline-flex items-center gap-1.5 font-bold text-primary hover:underline text-xs"
            >
              <Phone size={13} /> Hotline Bệnh viện: 1900 6868 (24/7)
            </a>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-slate-900 p-4 text-center text-xs text-slate-400 border-t border-slate-800">
          <p className="flex items-center justify-center gap-1">
            Hệ sinh thái Quản lý Thú cưng Thông minh <Heart size={12} className="text-rose-500 fill-rose-500" /> NIPONETO
          </p>
        </div>
      </div>
    </div>
  );
}
