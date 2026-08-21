import { AppLayout } from "../../components/layout/AppLayout";
import { AppointmentList } from "../../components/shared/AppointmentList";
import { Card } from "../../components/ui/Card";

export function AppointmentsPage() {
  return <AppLayout type="owner" title="Quản lý lịch khám"><div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]"><Card title="October 2026"><div className="grid grid-cols-7 gap-2 text-center text-sm">{Array.from({ length: 35 }, (_, i) => <div key={i} className={`rounded-xl p-3 ${[8, 15, 22].includes(i) ? "bg-aqua font-bold text-primary" : "bg-slate-50"}`}>{i + 1}</div>)}</div></Card><Card title="Today's Schedule"><AppointmentList /></Card></div></AppLayout>;
}