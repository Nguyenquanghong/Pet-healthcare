import { Link } from "react-router-dom";
import { CalendarPlus, Hotel, Plus, PawPrint } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { PetSummaryCard } from "../../components/owner/dashboard/PetSummaryCard";
import { UpcomingSchedule } from "../../components/owner/dashboard/UpcomingSchedule";
import { OwnerNotificationPanel } from "../../components/owner/dashboard/OwnerNotificationPanel";
import { ClinicMapCard } from "../../components/owner/dashboard/ClinicMapCard";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAppStore } from "../../store/AppStoreProvider";

export function DashboardPage() {
  const { currentOwner, ownerPets, appointments } = useAppStore();
  
  // Get upcoming appointments for the owner
  const upcomingAppointments = appointments.filter(a => ownerPets.some(p => p.id === a.petId) && a.status === 'confirmed');

  return (
    <OwnerLayout title="Tổng quan">
      <div className="mb-6">
        <h2 className="text-2xl font-black text-slate-900">Xin chào, {currentOwner.fullName}</h2>
        <p className="mt-1 text-slate-600">
          Quản lý hồ sơ thú cưng, lịch khám, hotel booking và thông báo chăm sóc trong một nơi.
        </p>
      </div>

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <Link to="/owner/pets" className="rounded-2xl border border-primary/10 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-soft">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Plus size={18} /></div>
          <p className="font-black text-slate-900">Thêm / sửa thú cưng</p>
          <p className="mt-1 text-sm text-slate-500">Cập nhật hồ sơ để sử dụng dịch vụ nhanh hơn.</p>
        </Link>
        <Link to="/owner/appointments" className="rounded-2xl border border-primary/10 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-soft">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><CalendarPlus size={18} /></div>
          <p className="font-black text-slate-900">Đặt lịch khám</p>
          <p className="mt-1 text-sm text-slate-500">Gửi yêu cầu khám, tiêm phòng hoặc tư vấn.</p>
        </Link>
        <Link to="/owner/hotel-booking" className="rounded-2xl border border-primary/10 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-soft">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><Hotel size={18} /></div>
          <p className="font-black text-slate-900">Đặt hotel thú cưng</p>
          <p className="mt-1 text-sm text-slate-500">Chọn phòng, dịch vụ thêm và theo dõi lưu trú.</p>
        </Link>
      </div>

      {ownerPets.length === 0 && (
        <div className="mb-6">
          <EmptyState
            icon={<PawPrint size={42} />}
            title="Bạn chưa có hồ sơ thú cưng"
            description="Hãy thêm thú cưng đầu tiên để bắt đầu đặt lịch khám, theo dõi hồ sơ y tế và sử dụng dịch vụ khách sạn."
            action={<Link to="/owner/pets"><Button icon={<Plus size={16} />}>Thêm thú cưng đầu tiên</Button></Link>}
          />
        </div>
      )}
      
      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900">Thú cưng của bạn</h3>
              <Link to="/owner/pets" className="text-sm font-semibold text-primary hover:underline">Xem tất cả</Link>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {ownerPets.map((pet) => (
                <PetSummaryCard key={pet.id} pet={pet} />
              ))}
            </div>
          </div>
          
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                Thông báo & Ưu đãi
              </h3>
            </div>
            <div className="p-5">
              <OwnerNotificationPanel />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-xl font-bold text-slate-900">Lịch trình sắp tới</h3>
            </div>
            <div className="p-5">
              <UpcomingSchedule appointments={upcomingAppointments} />
            </div>
          </div>
          
          <ClinicMapCard />
        </div>
      </div>
    </OwnerLayout>
  );
}