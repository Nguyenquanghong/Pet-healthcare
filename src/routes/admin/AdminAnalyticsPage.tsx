import { useMemo, useState } from "react";
import {
  TrendingUp,
  DollarSign,
  Hotel,
  Stethoscope,
  Users,
  Calendar,
  CheckCircle2,
  PieChart,
  BarChart3,
  Award,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { formatCurrency } from "../../utils/formatCurrency";

export function AdminAnalyticsPage() {
  const { appointments, hotelBookings, pets, owners, medicalRecords } = useAppStore();
  const [timeRange, setTimeRange] = useState("all");

  // Revenue computations
  const totalHotelRevenue = useMemo(() => {
    return hotelBookings
      .filter((b) => ["in_stay", "checked_out"].includes(b.status))
      .reduce((sum, b) => sum + b.totalAmount, 0);
  }, [hotelBookings]);

  // Estimate appointment revenue (150.000đ - 350.000đ per appointment)
  const totalAppointmentRevenue = useMemo(() => {
    return appointments
      .filter((a) => ["completed", "confirmed", "in_progress"].includes(a.status))
      .reduce((sum) => sum + 250000, 0);
  }, [appointments]);

  const totalRevenue = totalHotelRevenue + totalAppointmentRevenue;

  // Appointment status breakdown
  const appointmentStats = useMemo(() => {
    const total = appointments.length || 1;
    const completed = appointments.filter((a) => a.status === "completed").length;
    const confirmed = appointments.filter((a) => a.status === "confirmed").length;
    const pending = appointments.filter((a) => a.status === "pending").length;
    const cancelled = appointments.filter((a) => a.status === "cancelled").length;

    return {
      total,
      completed,
      completedPct: Math.round((completed / total) * 100),
      confirmed,
      confirmedPct: Math.round((confirmed / total) * 100),
      pending,
      pendingPct: Math.round((pending / total) * 100),
      cancelled,
      cancelledPct: Math.round((cancelled / total) * 100),
    };
  }, [appointments]);

  // Species breakdown
  const speciesStats = useMemo(() => {
    const dogs = pets.filter((p) => p.species === "dog").length;
    const cats = pets.filter((p) => p.species === "cat").length;
    const others = pets.length - (dogs + cats);
    const total = pets.length || 1;

    return {
      dogs,
      dogsPct: Math.round((dogs / total) * 100),
      cats,
      catsPct: Math.round((cats / total) * 100),
      others,
      othersPct: Math.round((others / total) * 100),
    };
  }, [pets]);

  return (
    <AdminLayout title="Báo cáo & Thống kê">
      {/* Time Range Filter Header */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">Tổng quan hiệu suất hoạt động</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Báo cáo tổng hợp doanh thu, tỷ lệ dịch vụ và hoạt động vận hành bệnh viện.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-slate-400" />
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 focus:border-primary focus:outline-none"
          >
            <option value="all">Tất cả thời gian</option>
            <option value="this_month">Tháng này (11/2026)</option>
            <option value="last_month">Tháng trước (10/2026)</option>
          </select>
        </div>
      </div>

      {/* Top Metric Cards */}
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4 mb-8">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Tổng doanh thu ước tính
            </p>
            <p className="text-2xl font-black text-slate-900">{formatCurrency(totalRevenue)}</p>
            <p className="text-[11px] font-semibold text-emerald-600 mt-1 flex items-center gap-1">
              <TrendingUp size={12} /> +18.4% so với tháng trước
            </p>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-soft">
            <DollarSign size={22} />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Doanh thu Khám chữa bệnh
            </p>
            <p className="text-2xl font-black text-slate-900">
              {formatCurrency(totalAppointmentRevenue)}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">{appointments.length} lượt khám đăng ký</p>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-white shadow-soft">
            <Stethoscope size={22} />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Doanh thu Hotel lưu trú
            </p>
            <p className="text-2xl font-black text-slate-900">{formatCurrency(totalHotelRevenue)}</p>
            <p className="text-[11px] text-slate-500 mt-1">{hotelBookings.length} kỳ lưu trú</p>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-soft">
            <Hotel size={22} />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
              Hồ sơ bệnh án đã lưu
            </p>
            <p className="text-2xl font-black text-slate-900">{medicalRecords.length}</p>
            <p className="text-[11px] text-slate-500 mt-1">{pets.length} thú cưng theo dõi</p>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-soft">
            <Award size={22} />
          </div>
        </div>
      </div>

      {/* Analytics Breakdown Grid */}
      <div className="grid gap-6 md:grid-cols-2 mb-8">
        {/* Appointment Status Analytics */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <BarChart3 size={18} className="text-primary" />
            Tỷ lệ Trạng thái Lịch khám
          </h3>

          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>Hoàn thành ({appointmentStats.completed})</span>
                <span>{appointmentStats.completedPct}%</span>
              </div>
              <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${appointmentStats.completedPct}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>Đã xác nhận ({appointmentStats.confirmed})</span>
                <span>{appointmentStats.confirmedPct}%</span>
              </div>
              <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${appointmentStats.confirmedPct}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>Chờ xử lý ({appointmentStats.pending})</span>
                <span>{appointmentStats.pendingPct}%</span>
              </div>
              <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all duration-500"
                  style={{ width: `${appointmentStats.pendingPct}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>Đã hủy ({appointmentStats.cancelled})</span>
                <span>{appointmentStats.cancelledPct}%</span>
              </div>
              <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-rose-500 rounded-full transition-all duration-500"
                  style={{ width: `${appointmentStats.cancelledPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Species Breakdown */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <PieChart size={18} className="text-indigo-600" />
            Phân bổ Thú cưng Theo Giống loài
          </h3>

          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>🐶 Chó ({speciesStats.dogs})</span>
                <span>{speciesStats.dogsPct}%</span>
              </div>
              <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                  style={{ width: `${speciesStats.dogsPct}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                <span>🐱 Mèo ({speciesStats.cats})</span>
                <span>{speciesStats.catsPct}%</span>
              </div>
              <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-pink-500 rounded-full transition-all duration-500"
                  style={{ width: `${speciesStats.catsPct}%` }}
                />
              </div>
            </div>

            {speciesStats.others > 0 && (
              <div>
                <div className="flex justify-between text-xs font-bold text-slate-700 mb-1">
                  <span>🐾 Thú cưng khác ({speciesStats.others})</span>
                  <span>{speciesStats.othersPct}%</span>
                </div>
                <div className="h-3.5 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-slate-400 rounded-full transition-all duration-500"
                    style={{ width: `${speciesStats.othersPct}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Staff & Clinic Performance Table */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
          <Users size={18} className="text-primary" />
          Hiệu suất Khám chữa bệnh của Bác sĩ
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase font-bold text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-5 py-3">Bác sĩ phụ trách</th>
                <th className="px-5 py-3">Chuyên khoa</th>
                <th className="px-5 py-3">Số ca đã khám</th>
                <th className="px-5 py-3">Bệnh án đã lập</th>
                <th className="px-5 py-3 text-right">Đánh giá khách hàng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="hover:bg-slate-50">
                <td className="px-5 py-3.5 font-bold text-slate-900">Bs. Mai Nguyễn</td>
                <td className="px-5 py-3.5 text-xs text-slate-600">Đa khoa & Nội nhi Thú y</td>
                <td className="px-5 py-3.5 font-bold text-slate-800">14 ca</td>
                <td className="px-5 py-3.5 text-slate-700">12 hồ sơ</td>
                <td className="px-5 py-3.5 text-right font-bold text-amber-500">⭐ 4.9/5.0</td>
              </tr>
              <tr className="hover:bg-slate-50">
                <td className="px-5 py-3.5 font-bold text-slate-900">Dr. Kenji Sato</td>
                <td className="px-5 py-3.5 text-xs text-slate-600">Da liễu & Phẫu thuật Chỉnh hình</td>
                <td className="px-5 py-3.5 font-bold text-slate-800">9 ca</td>
                <td className="px-5 py-3.5 text-slate-700">8 hồ sơ</td>
                <td className="px-5 py-3.5 text-right font-bold text-amber-500">⭐ 5.0/5.0</td>
              </tr>
              <tr className="hover:bg-slate-50">
                <td className="px-5 py-3.5 font-bold text-slate-900">Bs. Trần Anh</td>
                <td className="px-5 py-3.5 text-xs text-slate-600">Nha khoa & Phẫu thuật Thú y</td>
                <td className="px-5 py-3.5 font-bold text-slate-800">6 ca</td>
                <td className="px-5 py-3.5 text-slate-700">5 hồ sơ</td>
                <td className="px-5 py-3.5 text-right font-bold text-amber-500">⭐ 4.8/5.0</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
