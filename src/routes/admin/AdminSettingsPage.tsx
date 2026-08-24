import { useState } from "react";
import {
  RotateCcw,
  ShieldAlert,
  Database,
  Building,
  Clock,
  Phone,
  CheckCircle2,
  X,
  Stethoscope,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { mockApi } from "../../services/mockApi";

export function AdminSettingsPage() {
  const { resetStoreData, pets, appointments, hotelBookings, medicalRecords, owners } = useAppStore();
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  const handleResetData = async () => {
    setIsResetting(true);
    await mockApi.system.resetData();
    resetStoreData();
    setIsResetting(false);
    setResetModalOpen(false);
    setToastMsg("Đã khôi phục dữ liệu mẫu thành công!");
    setTimeout(() => setToastMsg(""), 3500);
  };

  return (
    <AdminLayout title="Cài đặt hệ thống">
      {toastMsg && (
        <div className="mb-6 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} /> {toastMsg}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Clinic Info */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <Building size={20} className="text-primary" />
            Thông tin Bệnh viện Thú y
          </h2>

          <div className="space-y-4 text-sm">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                Tên bệnh viện
              </label>
              <p className="font-semibold text-slate-800">Bệnh viện Thú y Mỹ Đình — Nippon Pet Care</p>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                Địa chỉ
              </label>
              <p className="text-slate-700">18 Phạm Hùng, Phường Mỹ Đình 2, Nam Từ Liêm, Hà Nội</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Hotline hỗ trợ
                </label>
                <p className="font-bold text-primary flex items-center gap-1.5">
                  <Phone size={14} /> 1900 6868
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Giờ mở cửa
                </label>
                <p className="font-semibold text-slate-700 flex items-center gap-1.5">
                  <Clock size={14} /> 08:00 – 20:00 (T2–CN)
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Staff / Doctors Info */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <Stethoscope size={20} className="text-indigo-600" />
            Bác sĩ & Nhân viên trực
          </h2>

          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div>
                <p className="font-bold text-slate-900 text-sm">Bs. Mai Nguyễn</p>
                <p className="text-xs text-slate-500">Chuyên khoa Nội nhi & Đa khoa Thú y</p>
              </div>
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
                Đang trực
              </span>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div>
                <p className="font-bold text-slate-900 text-sm">Dr. Kenji Sato</p>
                <p className="text-xs text-slate-500">Chuyên gia Da liễu & Phẫu thuật Nhật Bản</p>
              </div>
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
                Đang trực
              </span>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div>
                <p className="font-bold text-slate-900 text-sm">Bs. Trần Anh</p>
                <p className="text-xs text-slate-500">Chuyên khoa Nha khoa & Phẫu thuật Chỉnh hình</p>
              </div>
              <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">
                Nghỉ ca
              </span>
            </div>
          </div>
        </div>

        {/* Data Persistence & Reset Management */}
        <div className="md:col-span-2 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900 mb-2 flex items-center gap-2">
            <Database size={20} className="text-amber-500" />
            Quản lý Dữ liệu Persistence (Mock Store)
          </h2>
          <p className="text-xs text-slate-500 mb-5">
            Dữ liệu hệ thống đang được lưu trữ cục bộ tự động trong <code>localStorage</code>. Bạn có thể kiểm tra trạng thái thống kê hoặc khôi phục dữ liệu mẫu ban đầu.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
              <p className="text-[11px] font-bold text-slate-400 uppercase">Chủ nuôi</p>
              <p className="text-xl font-black text-slate-900">{owners.length}</p>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
              <p className="text-[11px] font-bold text-slate-400 uppercase">Thú cưng</p>
              <p className="text-xl font-black text-slate-900">{pets.length}</p>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
              <p className="text-[11px] font-bold text-slate-400 uppercase">Lịch khám</p>
              <p className="text-xl font-black text-slate-900">{appointments.length}</p>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
              <p className="text-[11px] font-bold text-slate-400 uppercase">Bệnh án</p>
              <p className="text-xl font-black text-slate-900">{medicalRecords.length}</p>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
              <p className="text-[11px] font-bold text-slate-400 uppercase">Hotel Bookings</p>
              <p className="text-xl font-black text-slate-900">{hotelBookings.length}</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-xl bg-amber-50/70 border border-amber-200">
            <div>
              <p className="font-bold text-amber-900 text-sm flex items-center gap-1.5">
                <ShieldAlert size={16} /> Khôi phục dữ liệu mẫu (Reset Mock Data)
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                Xóa toàn bộ các chỉnh sửa thử nghiệm và đặt lại dữ liệu demo mặc định của hệ thống.
              </p>
            </div>

            <button
              onClick={() => setResetModalOpen(true)}
              className="flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-amber-700 transition-colors shadow-xs"
            >
              <RotateCcw size={14} /> Khôi phục dữ liệu gốc
            </button>
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {resetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-amber-700 flex items-center gap-2">
                <RotateCcw size={20} />
                Xác nhận khôi phục dữ liệu gốc
              </h3>
              <button
                onClick={() => setResetModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-2 text-sm text-slate-600">
              <p>
                Bạn có chắc chắn muốn khôi phục lại dữ liệu mẫu mặc định không?
              </p>
              <p className="text-xs text-rose-600 font-semibold">
                Toàn bộ thú cưng, lịch khám và hotel booking tự tạo thử nghiệm sẽ được đưa về cài đặt ban đầu.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setResetModalOpen(false)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Quay lại
              </button>
              <button
                onClick={handleResetData}
                disabled={isResetting}
                className="flex-1 rounded-xl bg-amber-600 py-2.5 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {isResetting ? "Đang khôi phục..." : "Xác nhận khôi phục"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
