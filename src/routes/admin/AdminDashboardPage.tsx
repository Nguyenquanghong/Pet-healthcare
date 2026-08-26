import { BedDouble, CalendarDays, CheckCircle2, Clock, PawPrint, Users, Zap, Bell, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { appointmentStatusLabels, bookingStatusLabels } from "../../utils/statusLabels";
import { formatCurrency } from "../../utils/formatCurrency";

function StatCard({ label, value, icon: Icon, color, subtitle }: { label: string; value: number; icon: React.ElementType; color: string; subtitle?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex items-center gap-5 hover:shadow-md transition-shadow">
      <div className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl ${color}`}>
        <Icon size={24} className="text-white" />
      </div>
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-3xl font-black text-slate-900">{value}</p>
        {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const navigate = useNavigate();
  const { appointments, hotelBookings, pets, owners, notifications, medicalRecords, updateAppointmentStatus, updateHotelBookingStatus } = useAppStore();

  const today = new Date().toISOString().slice(0, 10);
  const todayAppointments = appointments.filter(a => a.date === today || a.status === "confirmed" || a.status === "pending");
  const pendingAppointments = appointments.filter(a => a.status === "pending");
  const pendingBookings = hotelBookings.filter(b => b.status === "pending");
  const checkedInBookings = hotelBookings.filter(b => b.status === "in_stay");
  const unreadNotifications = notifications.filter(n => n.recipientRole === "admin" && n.status === "sent").length;

  return (
    <AdminLayout title="Dashboard">
      {/* Stat Cards — 6 columns */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="Lịch hôm nay" value={todayAppointments.length} icon={CalendarDays} color="bg-primary" />
        <StatCard label="Chờ xác nhận" value={pendingAppointments.length} icon={Clock} color="bg-amber-500" subtitle="Lịch khám" />
        <StatCard label="Pet đang lưu trú" value={checkedInBookings.length} icon={BedDouble} color="bg-emerald-600" />
        <StatCard label="Tổng thú cưng" value={pets.length} icon={PawPrint} color="bg-indigo-600" subtitle={`${pets.filter(p => p.species === "dog").length} chó · ${pets.filter(p => p.species === "cat").length} mèo`} />
        <StatCard label="Chủ nuôi" value={owners.length} icon={Users} color="bg-cyan-600" />
        <StatCard label="Thông báo mới" value={unreadNotifications} icon={Bell} color="bg-rose-500" />
      </div>

      {/* Quick Actions Panel */}
      {(pendingAppointments.length > 0 || pendingBookings.length > 0) && (
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
          <h2 className="text-sm font-bold text-amber-800 mb-3 flex items-center gap-2">
            <Zap size={16} /> Hành động nhanh — Cần xử lý
          </h2>
          <div className="flex flex-wrap gap-2">
            {pendingAppointments.slice(0, 3).map(a => {
              const pet = pets.find(p => p.id === a.petId);
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    updateAppointmentStatus(a.id, "confirmed");
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-xs font-bold text-amber-800 hover:bg-amber-100 transition-colors shadow-xs"
                >
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  Xác nhận lịch {pet?.name} · {a.time} {a.date}
                </button>
              );
            })}
            {pendingBookings.slice(0, 3).map(b => {
              const pet = pets.find(p => p.id === b.petId);
              return (
                <button
                  key={b.id}
                  onClick={() => {
                    updateHotelBookingStatus(b.id, "confirmed");
                  }}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-xs font-bold text-amber-800 hover:bg-amber-100 transition-colors shadow-xs"
                >
                  <BedDouble size={14} className="text-indigo-600" />
                  Xác nhận hotel {pet?.name} · {b.checkIn} → {b.checkOut}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        {/* Today Appointments */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
            <h2 className="text-xl font-bold text-slate-900">Lịch khám hôm nay</h2>
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
          <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
            <h2 className="text-xl font-bold text-slate-900">Hotel Booking chờ xử lý</h2>
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
                      onClick={() => updateHotelBookingStatus(b.id, "confirmed")}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-dark transition-colors"
                    >
                      Xác nhận
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
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        {/* Pets Currently In Hotel */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-6 py-5">
            <h2 className="text-xl font-bold text-slate-900">🏨 Pet đang lưu trú</h2>
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
                  <span className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700 animate-pulse">
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
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
            <h2 className="text-xl font-bold text-slate-900">📋 Bệnh án gần đây</h2>
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