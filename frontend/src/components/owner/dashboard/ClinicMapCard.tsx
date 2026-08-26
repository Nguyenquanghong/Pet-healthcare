import { Car } from "lucide-react";

export function ClinicMapCard() {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="relative h-36 bg-slate-200">
        <img 
          src="https://media.wired.com/photos/59269cd37034dc5f91bec0f1/master/pass/GoogleMapTA.jpg" 
          alt="Bản đồ" 
          className="h-full w-full object-cover"
        />
      </div>
      <div className="border-t border-slate-200 p-4">
        <h4 className="text-sm font-semibold text-slate-900">Bệnh viện Thú y Mỹ Đình</h4>
        <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
          <Car size={16} />
          <span>Cách bạn 2.4 km &bull; Đang mở cửa</span>
        </div>
      </div>
    </div>
  );
}
