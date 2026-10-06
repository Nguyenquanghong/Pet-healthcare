import { useApiQuery } from "../../../services/useApiQuery";
import { useSession } from "../../../store/SessionContext";
import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { todayIso } from "../../../utils/date";

interface OwnerAppointmentCalendarProps {
  category?: "medical" | "spa";
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
  category = "medical",
  selectedDate,
  onSelectDate,
  onClearDate,
}: OwnerAppointmentCalendarProps) {
  const fallbackMonth = selectedDate ? toMonthKey(selectedDate) : toMonthKey(todayIso());
  const [visibleMonth, setVisibleMonth] = useState(fallbackMonth);

  useEffect(() => {
    if (selectedDate) setVisibleMonth(toMonthKey(selectedDate));
  }, [selectedDate]);

  const [visibleYear, visibleMonthNumber] = visibleMonth.split("-").map(Number);
  const daysInMonth = getDaysInMonth(visibleMonth);
  const firstDayOffset = (new Date(visibleYear, visibleMonthNumber - 1, 1).getDay() + 6) % 7;

  const { authRole } = useSession();
  const calendar = useApiQuery<Record<string, number>>("/appointments/calendar?month=" + visibleMonth + "&category=" + category, {
    enabled: Boolean(authRole), refreshOnTick: true,
  });
  const appointmentCountByDate = calendar.data ?? {};

  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const value = makeDateValue(visibleMonth, day);
    return {
      value,
      day,
      count: appointmentCountByDate[value] ?? 0,
    };
  });

  const selectedCount = selectedDate ? appointmentCountByDate[selectedDate] ?? 0 : 0;

  const changeMonth = (monthKey: string) => {
    setVisibleMonth(monthKey);
    if (selectedDate && toMonthKey(selectedDate) !== monthKey) onClearDate();
  };

  const goToMonth = (offset: number) => {
    const nextMonthIndex = visibleMonthNumber - 1 + offset;
    const nextDate = new Date(visibleYear, nextMonthIndex, 1);
    changeMonth(`${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`);
  };

  const handleMonthChange = (monthIndex: number) => {
    changeMonth(`${visibleYear}-${String(monthIndex + 1).padStart(2, "0")}`);
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

      {calendar.loading && <p role="status" className="text-sm text-slate-500">Đang tải lịch theo tháng...</p>}
      {calendar.error && <p role="alert" className="text-sm text-rose-700">Chưa tải được lịch theo tháng. <button type="button" className="underline" onClick={() => void calendar.reload().catch(() => undefined)}>Thử lại</button></p>}
      <div className="mb-2 grid grid-cols-7 gap-2 text-center text-xs font-semibold text-slate-500">
        {["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "CN"].map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
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
              aria-label={`${day.value}, ${day.count} lịch hẹn`}
              aria-pressed={isSelected}
              style={day.day === 1 ? { gridColumnStart: firstDayOffset + 1 } : undefined}
              className={`relative flex min-h-16 items-end justify-center rounded-md border px-1 pb-2 pt-6 text-center transition-colors ${
                hasAppointment
                  ? "border-primary/35 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10"
                  : "cursor-default border-slate-100 bg-slate-50 text-slate-400"
              } ${isSelected ? "bg-primary/10 ring-2 ring-primary ring-offset-2" : ""}`}
            >
              <p className="text-lg font-black">{day.day}</p>
              {hasAppointment && (
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-black text-white">
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
