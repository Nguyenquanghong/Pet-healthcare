import { MapPin } from "lucide-react";
import type { Appointment } from "../../../types/appointment";
import { pets } from "../../../data/mockData";

export function UpcomingSchedule({ appointments }: { appointments: Appointment[] }) {
  if (appointments.length === 0) {
    return <p className="text-sm text-slate-500 py-4">Không có lịch trình sắp tới.</p>;
  }

  return (
    <div className="space-y-4">
      {appointments.slice(0, 3).map((appointment, index) => {
        const pet = pets.find(p => p.id === appointment.petId);
        
        // Mock parsing date for UI
        const [year, month, day] = appointment.date.split("-");
        const monthShort = `Th ${parseInt(month)}`;
        const isHighlight = index === 0;

        return (
          <div key={appointment.id} className="flex gap-4 rounded-2xl border border-slate-200 bg-white p-4">
            <div className={`flex flex-col items-center justify-center rounded-xl px-4 py-2 text-center h-16 w-16 ${isHighlight ? 'bg-blue-100 text-primary' : 'bg-orange-100 text-orange-800'}`}>
              <span className="text-xl font-bold">{day}</span>
              <span className="text-xs font-semibold">{monthShort}</span>
            </div>
            
            <div className="flex-1">
              <h4 className="font-bold text-slate-900">{appointment.serviceName}</h4>
              <p className="text-sm text-slate-600 mt-0.5">
                Cho {pet?.name ?? "Thú cưng"} &bull; Bs. Trần
              </p>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                <MapPin size={12} />
                <span>Bệnh viện Thú y Mỹ Đình</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
