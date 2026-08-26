import type { HotelServiceKey } from "../../../types/booking";
import { HOTEL_SERVICE_PRICES } from "../../../utils/bookingCalculator";
import { formatCurrency } from "../../../utils/formatCurrency";

interface AdditionalServicesCardProps {
  serviceKeys: HotelServiceKey[];
  onToggleService: (value: HotelServiceKey) => void;
}

export function AdditionalServicesCard({ serviceKeys, onToggleService }: AdditionalServicesCardProps) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Dịch vụ thêm</label>
      <div className="grid grid-cols-1 gap-2">
        {Object.entries(HOTEL_SERVICE_PRICES).map(([key, service]) => {
          const serviceKey = key as HotelServiceKey;
          return (
            <label
              key={serviceKey}
              className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm transition-colors ${
                serviceKeys.includes(serviceKey) ? "border-primary bg-primary/5" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input type="checkbox" className="accent-primary" checked={serviceKeys.includes(serviceKey)} onChange={() => onToggleService(serviceKey)} />
              <span className="flex-1 font-medium text-slate-800">{service.label}</span>
              <span className="font-semibold text-primary">{formatCurrency(service.price)}{service.unit === "day" ? "/ngày" : ""}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
