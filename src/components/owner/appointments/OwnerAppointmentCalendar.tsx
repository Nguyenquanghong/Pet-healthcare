import type { Appointment } from "../../../types/appointment";

interface OwnerAppointmentCalendarProps {
  appointments: Appointment[];
}

export function OwnerAppointmentCalendar({ appointments }: OwnerAppointmentCalendarProps) {
  const upcomingDates = new Set(appointments.map((appointment) => appointment.date));
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date("2026-11-01T00:00:00");
    date.setDate(date.getDate() + index);
    const value = date.toISOString().slice(0, 10);
    return { value, day: date.getDate(), weekday: date.toLocaleDateString("vi-VN", { weekday: "short" }) };
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Lịch tháng 11</h3>
          <p className="text-sm text-slate-500">Các ngày có lịch hẹn được đánh dấu màu xanh.</p>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => {
          const hasAppointment = upcomingDates.has(day.value);
          return (
            <div
              key={day.value}
              className={`rounded-2xl border p-3 text-center ${
                hasAppointment ? "border-primary bg-primary/10 text-primary" : "border-slate-100 bg-slate-50 text-slate-500"
              }`}
            >
              <p className="text-xs font-semibold uppercase">{day.weekday}</p>
              <p className="mt-1 text-lg font-black">{day.day}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}