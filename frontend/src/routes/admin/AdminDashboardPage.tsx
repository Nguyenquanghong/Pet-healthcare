import { BedDouble, CalendarDays, CheckCircle2, Clock, PawPrint, Users, Zap, Bell, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { appointmentStatusLabels, bookingStatusLabels } from "../../utils/statusLabels";
import { formatCurrency } from "../../utils/formatCurrency";

function StatCard({ label, value, icon: Icon, subtitle }: { label: string; value: number; icon: React.ElementType; subtitle?: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-200 bg-white px-4 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-primary">
        <Icon size={17} />
      </div>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold text-slate-900">{value}</p>
        {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const { appointments, hotelBookings, pets, owners, medicalRecords, summary } = useAppStore();

  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const todayAppointments = appointments.filter(a => a.date === today);
  const pendingAppointments = appointments.filter(a => a.status === "pending");
  const pendingBookings = hotelBookings.filter(b => b.status === "pending");
  const checkedInBookings = hotelBookings.filter(b => b.status === "in_stay");
  const unreadNotifications = summary.unread;

  return (
    <AdminLayout title="Dashboard">
      {/* Stat Cards — 6 columns */}
      <div className="grid overflow-hidden rounded-lg border border-slate-200 bg-white sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Lịch hôm nay" value={summary.todayAppointments} icon={CalendarDays} />
        <StatCard label="Chờ xác nhận" value={summary.appointmentStatus.pending ?? 0} icon={Clock} subtitle="Lịch khám" />
        <StatCard label="Pet đang lưu trú" value={summary.hotelStatus.in_stay ?? 0} icon={BedDouble} />
        <StatCard label="Tổng thú cưng" value={summary.totals.pets ?? 0} icon={PawPrint} subtitle={`${summary.species.dog ?? 0} chó · ${summary.species.cat ?? 0} mèo`} />
        <StatCard label="Chủ nuôi" value={summary.totals.owners ?? 0} icon={Users} />
        <StatCard label="Thông báo mới" value={unreadNotifications} icon={Bell} />
      </div>

      {/* Quick Actions Panel */}
      {(pendingAppointments.length > 0 || pendingBookings.length > 0) && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-white p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Zap size={16} /> Hành động nhanh — Cần xử lý
          </h2>
          <div className="flex flex-wrap gap-2">
            {pendingAppointments.slice(0, 3).map(a => {
              const pet = pets.find(p => p.id === a.petId);
              return (
                <button
                  key={a.id}
                  onClick={() => navigate("/admin/appointments")}
                  className="inline-flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100"
                >
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  Xem và xác nhận lịch {pet?.name} · {a.time} {a.date}
                </button>
              );
            })}
            {pendingBookings.slice(0, 3).map(b => {
              const pet = pets.find(p => p.id === b.petId);
              return (
                <button
                  key={b.id}
                  onClick={() => navigate("/admin/hotel-bookings")}
                  className="inline-flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100"
                >
                  <BedDouble size={14} className="text-indigo-600" />
                  Xem và xác nhận hotel {pet?.name} · {b.checkIn} → {b.checkOut}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        {/* Today Appointments */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Lịch khám hôm nay</h2>
            <button
              onClick={() => navigate("/admin/appointments")}
              className="text-xs font-bold text-primary hover:underline inline-flex items-center gap-1"
            >
              Xem tất cả <ChevronRight size={14} />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {todayAppointments.slice(0, 5).map(a => {
              const pet = pets.find(p => p.id === a.petId);
              const owner = owners.find(o => o.id === a.ownerId);
              return (
                <div key={a.id} className="flex items-center justify-between gap-4 px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-9 w-12 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-700">
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
                        onClick={() => navigate("/admin/appointments")}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-dark transition-colors"
                      >
                        Xem và xác nhận
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
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Hotel Booking chờ xử lý</h2>
            <button
              onClick={() => navigate("/admin/hotel-bookings")}
              className="text-xs font-bold text-primary hover:underline inline-flex items-center gap-1"
            >
              Xem tất cả <ChevronRight size={14} />
            </button>
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
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-50 text-amber-700">
                      {bookingStatusLabels[b.status]}
                    </span>
                    <button
                      onClick={() => navigate("/admin/hotel-bookings")}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-dark transition-colors"
                    >
                      Xem và xác nhận
                    </button>
                  </div>
                </div>
              );
            })}
            {pendingBookings.length === 0 && (
              <p className="px-6 py-8 text-center text-slate-400">Không có booking chờ xử lý.</p>
            )}
          </div>
        </div>
      </div>

      {/* Pets In Stay + Recent Medical Records */}
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        {/* Pets Currently In Hotel */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-6 py-5">
            <h2 className="text-base font-semibold text-slate-900">Pet đang lưu trú</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {checkedInBookings.map(b => {
              const pet = pets.find(p => p.id === b.petId);
              const owner = owners.find(o => o.id === b.ownerId);
              return (
                <div key={b.id} className="flex items-center justify-between gap-4 px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-lg">
                      {pet?.species === "cat" ? "🐈" : "🐕"}
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">{pet?.name}</p>
                      <p className="text-xs text-slate-500">{owner?.fullName} · {b.checkIn} → {b.checkOut}</p>
                    </div>
                  </div>
                  <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    Đang lưu trú
                  </span>
                </div>
              );
            })}
            {checkedInBookings.length === 0 && (
              <p className="px-6 py-8 text-center text-slate-400">Không có pet nào đang lưu trú.</p>
            )}
          </div>
        </div>

        {/* Recent Medical Records */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Bệnh án gần đây</h2>
            <button
              onClick={() => navigate("/admin/medical-records")}
              className="text-xs font-bold text-primary hover:underline inline-flex items-center gap-1"
            >
              Xem tất cả <ChevronRight size={14} />
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {medicalRecords.slice(0, 4).map(r => {
              const pet = pets.find(p => p.id === r.petId);
              return (
                <div key={r.id} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">{r.title}</p>
                    <span className="text-xs text-slate-400">{r.visitDate}</span>
                  </div>
                  <p className="text-sm text-slate-500 mt-0.5">{pet?.name} · {r.doctorName}</p>
                </div>
              );
            })}
            {medicalRecords.length === 0 && (
              <p className="px-6 py-8 text-center text-slate-400">Chưa có bệnh án nào.</p>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
