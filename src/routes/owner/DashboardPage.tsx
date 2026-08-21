import { Stethoscope } from "lucide-react";
import { AppLayout } from "../../components/layout/AppLayout";
import { AppointmentList } from "../../components/shared/AppointmentList";
import { NotificationList } from "../../components/shared/NotificationList";
import { Card } from "../../components/ui/Card";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { pets } from "../../data/mockData";

export function DashboardPage() {
  return (
    <AppLayout type="owner" title="Tổng quan">
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <p className="text-sm text-slate-500">Xin chào, Nguyễn Văn A</p>
          <h2 className="mt-2 text-3xl font-black">Hôm nay thú cưng của bạn thế nào?</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">{pets.map((pet) => <PetCard key={pet.id} pet={pet} />)}</div>
        </Card>
        <Card title="Lịch trình sắp tới"><AppointmentList /></Card>
        <Card title="Thông báo & ưu đãi"><NotificationList /></Card>
        <Card title="Bệnh viện gần bạn"><div className="h-48 rounded-2xl bg-gradient-to-br from-cyan-100 via-blue-100 to-slate-200 p-5"><Stethoscope className="text-primary" /><p className="mt-12 font-bold">Bệnh viện Thú y Mỹ Đình</p><p className="text-sm text-slate-600">Đang mở cửa · 2.4 km</p></div></Card>
      </div>
    </AppLayout>
  );
}

function PetCard({ pet }: { pet: (typeof pets)[number] }) {
  return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-aqua text-2xl">🐾</div><h3 className="font-bold">{pet.name}</h3><p className="text-sm text-slate-500">{pet.breed} · {pet.age}</p><div className="mt-3"><StatusBadge>{pet.status}</StatusBadge></div></div>;
}