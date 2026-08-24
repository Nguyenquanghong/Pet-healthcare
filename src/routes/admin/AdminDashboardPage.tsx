import { BedDouble, CalendarDays, CheckCircle2, Clock } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { appointmentStatusLabels } from "../../utils/statusLabels";
import { bookingStatusLabels } from "../../utils/statusLabels";
import { formatCurrency } from "../../utils/formatCurrency";

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex items-center gap-5">
      <div className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl ${color}`}>
        <Icon size={24} className="text-white" />
      </div>
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-3xl font-black text-slate-900">{value}</p>
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const { appointments, hotelBookings, pets, owners, notifications, updateAppointmentStatus } = useAppStore();

  const today = new Date().toISOString().slice(0, 10);
  const todayAppointments = appointments.filter(a => a.date === today || a.status === "confirmed" || a.status === "pending");
  const pendingAppointments = appointments.filter(a => a.status === "pending");
  const pendingBookings = hotelBookings.filter(b => b.status === "pending");
  const checkedInBookings = hotelBookings.filter(b => b.status === "checked_in");
  const unreadNotifications = notifications.filter(n => n.status === "sent").length;

  return (
    <AdminLayout title="Dashboard">
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Lịch hôm nay" value={todayAppointments.length} icon={CalendarDays} color="bg-primary" />
        <StatCard label="Chờ xác nhận" value={pendingAppointments.length} icon={Clock} color="bg-amber-500" />
        <StatCard label="Pet đang lưu trú" value={checkedInBookings.length} icon={BedDouble} color="bg-emerald-600" />
        <StatCard label="Thông báo chưa đọc" value={unreadNotifications} icon={CheckCircle2} color="bg-rose-500" />
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        {/* Today Appointments */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-6 py-5">
            <h2 className="text-xl font-bold text-slate-900">Lịch khám hôm nay</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {todayAppointments.slice(0, 5).map(a => {
              const pet = pets.find(p => p.id === a.petId);
              const owner = owners.find(o => o.id === a.ownerId);
              return (
                <div key={a.id} className="flex items-center justify-between gap-4 px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-sm font-bold text-slate-600">
                      {a.time}
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900">{pet?.name} · {a.serviceName}</p>
                      <p className="text-sm text-slate-500">{owner?.fullName}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
                      a.status === "confirmed" ? "bg-emerald-50 text-emerald-700" :
                      a.status === "pending" ? "bg-amber-50 text-amber-700" :
                      a.status === "completed" ? "bg-slate-100 text-slate-600" :
                      "bg-rose-50 text-rose-700"
                    }`}>
                      {appointmentStatusLabels[a.status]}
                    </span>
                    {a.status === "pending" && (
                      <button
                        onClick={() => updateAppointmentStatus(a.id, "confirmed")}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-dark transition-colors"
                      >
                        Xác nhận
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {todayAppointments.length === 0 && (
              <p className="px-6 py-8 text-center text-slate-400">Không có lịch hôm nay.</p>
            )}
          </div>
        </div>

        {/* Pending Hotel Bookings */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-6 py-5">
            <h2 className="text-xl font-bold text-slate-900">Hotel Booking chờ xử lý</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {pendingBookings.slice(0, 5).map(b => {
              const pet = pets.find(p => p.id === b.petId);
              const owner = owners.find(o => o.id === b.ownerId);
              return (
                <div key={b.id} className="flex items-center justify-between gap-4 px-6 py-4">
                  <div>
                    <p className="font-semibold text-slate-900">{pet?.name} · {b.nights} đêm</p>
                    <p className="text-sm text-slate-500">{owner?.fullName} · {b.checkIn} → {b.checkOut}</p>
                    <p className="text-sm font-bold text-primary mt-1">{formatCurrency(b.totalAmount)}</p>
                  </div>
                  <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-50 text-amber-700">
                    {bookingStatusLabels[b.status]}
                  </span>
                </div>
              );
            })}
            {pendingBookings.length === 0 && (
              <p className="px-6 py-8 text-center text-slate-400">Không có booking chờ xử lý.</p>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}