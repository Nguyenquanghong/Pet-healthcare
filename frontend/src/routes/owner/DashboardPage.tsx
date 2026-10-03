import { useMemo } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, Hotel, Plus, PawPrint, FileText, ArrowRight, BedSingle } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { PetSummaryCard } from "../../components/owner/dashboard/PetSummaryCard";
import { UpcomingSchedule } from "../../components/owner/dashboard/UpcomingSchedule";
import { OwnerNotificationPanel } from "../../components/owner/dashboard/OwnerNotificationPanel";
import { ClinicMapCard } from "../../components/owner/dashboard/ClinicMapCard";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAppStore } from "../../store/AppStoreProvider";
import { bookingStatusLabels } from "../../utils/statusLabels";

export function DashboardPage() {
  const { currentOwner, ownerPets, appointments, hotelBookings, medicalRecords, summary } = useAppStore();

  // Upcoming appointments for the owner (both pending and confirmed)
  const upcomingAppointments = useMemo(() => {
    return appointments
      .filter((a) => ownerPets.some((p) => p.id === a.petId) && ["pending", "confirmed"].includes(a.status))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [appointments, ownerPets]);

  // Active or upcoming hotel bookings
  const activeHotelBookings = useMemo(() => {
    return hotelBookings.filter(
      (b) => b.ownerId === currentOwner.id && ["in_stay", "confirmed"].includes(b.status)
    );
  }, [hotelBookings, currentOwner.id]);

  // Latest medical record for any of owner's pets
  const latestMedicalRecord = useMemo(() => {
    const records = medicalRecords.filter((r) => ownerPets.some((p) => p.id === r.petId));
    return records.sort((a, b) => b.visitDate.localeCompare(a.visitDate))[0];
  }, [medicalRecords, ownerPets]);

  const unreadNotiCount = summary.unread;

  return (
    <OwnerLayout title="Tổng quan">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Xin chào, {currentOwner.fullName}</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Quản lý hồ sơ thú cưng, lịch khám, hotel booking và thông báo chăm sóc trong một nơi.
          </p>
        </div>
        {unreadNotiCount > 0 && (
          <Link
            to="/owner/notifications"
            className="inline-flex self-start items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-slate-50 md:self-auto"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {unreadNotiCount} thông báo mới
          </Link>
        )}
      </div>

      <div className="mb-6 grid divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white md:grid-cols-3 md:divide-x md:divide-y-0">
        <Link
          to="/owner/pets"
          className="border-b border-slate-200 p-4 transition-colors hover:bg-slate-50 md:border-b-0"
        >
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-slate-100 text-primary">
            <Plus size={18} />
          </div>
          <p className="text-sm font-semibold text-slate-900">Thêm / sửa thú cưng</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Cập nhật hồ sơ để sử dụng dịch vụ nhanh hơn.</p>
        </Link>
        <Link
          to="/owner/appointments"
          className="border-b border-slate-200 p-4 transition-colors hover:bg-slate-50 md:border-b-0"
        >
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-slate-100 text-primary">
            <CalendarPlus size={18} />
          </div>
          <p className="text-sm font-semibold text-slate-900">Đặt lịch khám</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Gửi yêu cầu khám, tiêm phòng hoặc tư vấn.</p>
        </Link>
        <Link
          to="/owner/hotel-booking"
          className="p-4 transition-colors hover:bg-slate-50"
        >
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-slate-100 text-primary">
            <Hotel size={18} />
          </div>
          <p className="text-sm font-semibold text-slate-900">Đặt hotel thú cưng</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">Chọn phòng, dịch vụ thêm và theo dõi lưu trú.</p>
        </Link>
      </div>

      {ownerPets.length === 0 && (
        <div className="mb-6">
          <EmptyState
            icon={<PawPrint size={42} />}
            title="Bạn chưa có hồ sơ thú cưng"
            description="Hãy thêm thú cưng đầu tiên để bắt đầu đặt lịch khám, theo dõi hồ sơ y tế và sử dụng dịch vụ khách sạn."
            action={
              <Link to="/owner/pets">
                <Button icon={<Plus size={16} />}>Thêm thú cưng đầu tiên</Button>
              </Link>
            }
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Thú cưng của bạn ({summary.totals.pets ?? 0})</h3>
              <Link to="/owner/pets" className="text-sm font-semibold text-primary hover:underline">
                Quản lý
              </Link>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {ownerPets.map((pet) => (
                <PetSummaryCard key={pet.id} pet={pet} />
              ))}
            </div>
          </div>

          {/* Active Hotel Stay Card */}
          {activeHotelBookings.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <BedSingle size={18} className="text-primary" />
                  Lưu trú khách sạn đang hoạt động
                </h3>
                <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                  {bookingStatusLabels[activeHotelBookings[0].status]}
                </span>
              </div>
              <div className="flex flex-col gap-3 text-xs text-slate-700 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-bold text-sm text-slate-900">
                    {ownerPets.find((p) => p.id === activeHotelBookings[0].petId)?.name ?? "Thú cưng"} &bull; Phòng{" "}
                    <span className="capitalize">{activeHotelBookings[0].roomType}</span>
                  </p>
                  <p className="text-slate-600 mt-0.5">
                    Thời gian: {activeHotelBookings[0].checkIn} &rarr; {activeHotelBookings[0].checkOut} (
                    {activeHotelBookings[0].nights} đêm)
                  </p>
                </div>
                <Link
                  to="/owner/hotel-booking"
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-semibold text-primary hover:bg-slate-50"
                >
                  Xem nhật ký chăm sóc <ArrowRight size={12} />
                </Link>
              </div>
            </div>
          )}

          {/* Latest Medical Record summary */}
          {latestMedicalRecord && (
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <FileText size={18} className="text-primary" />
                  Hồ sơ y tế gần nhất
                </h3>
                <span className="text-xs text-slate-500 font-semibold">{latestMedicalRecord.visitDate}</span>
              </div>
              <p className="text-sm font-semibold text-slate-800">{latestMedicalRecord.title}</p>
              <p className="text-xs text-slate-500 mt-1">
                Bác sĩ: {latestMedicalRecord.doctorName} &bull; Chẩn đoán: {latestMedicalRecord.diagnosis}
              </p>
              <div className="mt-3 text-right">
                <Link
                  to="/owner/medical-records"
                  className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                >
                  Xem toàn bộ bệnh án <ArrowRight size={12} />
                </Link>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                Thông báo & Nhắc nhở
              </h3>
            </div>
            <div className="p-5">
              <OwnerNotificationPanel />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-900">Lịch trình sắp tới</h3>
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
