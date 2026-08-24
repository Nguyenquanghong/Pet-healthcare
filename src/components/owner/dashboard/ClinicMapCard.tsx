import { Car } from "lucide-react";

export function ClinicMapCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="h-40 bg-slate-200 relative">
        <img 
          src="https://media.wired.com/photos/59269cd37034dc5f91bec0f1/master/pass/GoogleMapTA.jpg" 
          alt="Bản đồ" 
          className="w-full h-full object-cover opacity-80 mix-blend-multiply"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-white to-transparent" />
      </div>
      <div className="p-5 relative -mt-10 bg-white/90 backdrop-blur-sm mx-4 mb-4 rounded-xl shadow-sm border border-slate-100">
        <h4 className="font-bold text-slate-900">Bệnh viện Thú y Mỹ Đình</h4>
        <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
          <Car size={16} />
          <span>Cách bạn 2.4 km &bull; Đang mở cửa</span>
        </div>
      </div>
    </div>
  );
}
