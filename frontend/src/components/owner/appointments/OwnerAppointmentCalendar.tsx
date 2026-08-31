import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Appointment } from "../../../types/appointment";
import { todayIso } from "../../../utils/date";

interface OwnerAppointmentCalendarProps {
  appointments: Appointment[];
  selectedDate?: string;
  onSelectDate: (date: string) => void;
  onClearDate: () => void;
}

const monthNames = [
  "Tháng 1",
  "Tháng 2",
  "Tháng 3",
  "Tháng 4",
  "Tháng 5",
  "Tháng 6",
  "Tháng 7",
  "Tháng 8",
  "Tháng 9",
  "Tháng 10",
  "Tháng 11",
  "Tháng 12",
];

function toMonthKey(dateValue: string) {
  return dateValue.slice(0, 7);
}

function getDaysInMonth(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

function makeDateValue(monthKey: string, day: number) {
  return `${monthKey}-${String(day).padStart(2, "0")}`;
}

export function OwnerAppointmentCalendar({
  appointments,
  selectedDate,
  onSelectDate,
  onClearDate,
}: OwnerAppointmentCalendarProps) {
  const fallbackMonth = selectedDate ? toMonthKey(selectedDate) : toMonthKey(appointments[0]?.date ?? todayIso());
  const [visibleMonth, setVisibleMonth] = useState(fallbackMonth);

  useEffect(() => {
    if (selectedDate) setVisibleMonth(toMonthKey(selectedDate));
  }, [selectedDate]);

  const [visibleYear, visibleMonthNumber] = visibleMonth.split("-").map(Number);
  const daysInMonth = getDaysInMonth(visibleMonth);

  const appointmentCountByDate = useMemo(() => {
    return appointments.reduce<Record<string, number>>((acc, appointment) => {
      acc[appointment.date] = (acc[appointment.date] ?? 0) + 1;
      return acc;
    }, {});
  }, [appointments]);

  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const value = makeDateValue(visibleMonth, day);
    const date = new Date(`${value}T00:00:00`);
    return {
      value,
      day,
      weekday: date.toLocaleDateString("vi-VN", { weekday: "short" }),
      count: appointmentCountByDate[value] ?? 0,
    };
  });

  const selectedCount = selectedDate ? appointmentCountByDate[selectedDate] ?? 0 : 0;

  const goToMonth = (offset: number) => {
    const nextMonthIndex = visibleMonthNumber - 1 + offset;
    const nextDate = new Date(visibleYear, nextMonthIndex, 1);
    setVisibleMonth(`${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`);
  };

  const handleMonthChange = (monthIndex: number) => {
    setVisibleMonth(`${visibleYear}-${String(monthIndex + 1).padStart(2, "0")}`);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <CalendarDays size={18} className="text-primary" />
            Lịch {monthNames[visibleMonthNumber - 1]} / {visibleYear}
          </h3>
          <p className="text-sm text-slate-500">Bấm vào ngày có số lịch để xem chi tiết bên dưới.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => goToMonth(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:border-primary/30 hover:text-primary"
            aria-label="Tháng trước"
          >
            <ChevronLeft size={17} />
          </button>
          <select
            value={visibleMonthNumber - 1}
            onChange={(event) => handleMonthChange(Number(event.target.value))}
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 focus:border-primary focus:outline-none"
            aria-label="Chọn tháng"
          >
            {monthNames.map((month, index) => (
              <option key={month} value={index}>
                {month}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => goToMonth(1)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition hover:border-primary/30 hover:text-primary"
            aria-label="Tháng sau"
          >
            <ChevronRight size={17} />
          </button>
          {selectedDate && (
            <button
              type="button"
              onClick={onClearDate}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-primary/30 hover:text-primary"
            >
              <X size={13} />
              Bỏ chọn ngày
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-2">
        {days.map((day) => {
          const hasAppointment = day.count > 0;
          const isSelected = selectedDate === day.value;

          return (
            <button
              key={day.value}
              type="button"
              onClick={() => hasAppointment && onSelectDate(day.value)}
              disabled={!hasAppointment}
              aria-pressed={isSelected}
              className={`relative min-h-16 rounded-md border p-3 text-center transition-colors ${
                hasAppointment
                  ? "border-primary/35 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
                  : "cursor-default border-slate-100 bg-slate-50 text-slate-400"
              } ${isSelected ? "bg-primary/10 ring-2 ring-primary ring-offset-2" : ""}`}
            >
              <p className="text-xs font-semibold uppercase">{day.weekday}</p>
              <p className="mt-1 text-lg font-black">{day.day}</p>
              {hasAppointment && (
                <span className="absolute right-2 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-black text-white">
                  {day.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <div className="mt-4 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <p className="text-sm font-bold text-slate-900">
            Đang xem {selectedCount} lịch hẹn vào ngày {selectedDate}
          </p>
        </div>
      )}
    </div>
  );
}
