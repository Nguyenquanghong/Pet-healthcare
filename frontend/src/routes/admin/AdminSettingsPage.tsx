import { Building, Clock, Database, Phone, ShieldCheck } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";

export function AdminSettingsPage() {
  const { pets, appointments, hotelBookings, medicalRecords, owners } = useAppStore();
  const metrics = [
    ["Chủ nuôi", owners.length],
    ["Thú cưng", pets.length],
    ["Lịch khám", appointments.length],
    ["Hồ sơ y tế", medicalRecords.length],
    ["Hotel booking", hotelBookings.length],
  ];

  return (
    <AdminLayout title="Cài đặt hệ thống">
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-slate-900"><Building size={20} className="text-primary" /> Thông tin cơ sở minh họa</h2>
          <p className="mb-5 text-xs text-slate-500">Các thông tin dưới đây chưa được kết nối với cấu hình vận hành của cửa hàng.</p>
          <dl className="space-y-4 text-sm">
            <div><dt className="text-xs font-semibold text-slate-500">Tên cơ sở</dt><dd className="mt-1 font-medium text-slate-900">Nippon Pet Care</dd></div>
            <div><dt className="text-xs font-semibold text-slate-500">Địa chỉ</dt><dd className="mt-1 text-slate-700">18 Phạm Hùng, Mỹ Đình 2, Nam Từ Liêm, Hà Nội</dd></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><dt className="text-xs font-semibold text-slate-500">Hotline</dt><dd className="mt-1 flex items-center gap-1.5 font-medium text-primary"><Phone size={14} /> 1900 6868</dd></div>
              <div><dt className="text-xs font-semibold text-slate-500">Giờ làm việc</dt><dd className="mt-1 flex items-center gap-1.5 text-slate-700"><Clock size={14} /> 08:00 - 20:00</dd></div>
            </div>
          </dl>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-6 lg:col-span-2">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Database size={20} className="text-primary" /> Dữ liệu hệ thống</h2>
              <p className="mt-1 text-sm text-slate-500">Dữ liệu được lưu tập trung trong PostgreSQL và truy cập qua REST API có xác thực.</p>
            </div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700"><ShieldCheck size={14} /> API protected</span>
          </div>
          <div className="mt-5 grid grid-cols-2 border-y border-slate-200 sm:grid-cols-5">
            {metrics.map(([label, value], index) => (
              <div key={label} className={`px-3 py-4 text-center ${index ? "border-l border-slate-200" : ""}`}>
                <p className="text-xs text-slate-500">{label}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">Việc reset hoặc seed dữ liệu chỉ được thực hiện bằng lệnh quản trị ở backend, không thao tác từ trình duyệt.</p>
        </section>
      </div>
    </AdminLayout>
  );
}
