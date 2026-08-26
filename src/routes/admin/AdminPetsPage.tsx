import { useMemo, useState } from "react";
import { Search, X, Eye, FileText, Calendar, Weight, Thermometer } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Pet } from "../../types/pet";

const SPECIES_OPTIONS = [
  { key: "all", label: "Tất cả" },
  { key: "dog", label: "🐶 Chó" },
  { key: "cat", label: "🐱 Mèo" },
];

const HEALTH_OPTIONS = [
  { key: "all", label: "Tất cả" },
  { key: "healthy", label: "Khỏe mạnh" },
  { key: "stable", label: "Ổn định" },
  { key: "vaccination_due", label: "Cần tiêm phòng" },
  { key: "under_treatment", label: "Đang điều trị" },
  { key: "critical", label: "Nguy kịch" },
];

const statusColors: Record<string, string> = {
  healthy: "bg-emerald-50 text-emerald-700",
  stable: "bg-blue-50 text-blue-700",
  vaccination_due: "bg-amber-50 text-amber-700",
  under_treatment: "bg-orange-50 text-orange-700",
  critical: "bg-rose-50 text-rose-700",
};

const statusLabels: Record<string, string> = {
  healthy: "Khỏe mạnh",
  stable: "Ổn định",
  vaccination_due: "Cần tiêm phòng",
  under_treatment: "Đang điều trị",
  critical: "Nguy kịch",
};

export function AdminPetsPage() {
  const { pets, owners, medicalRecords, appointments } = useAppStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [speciesFilter, setSpeciesFilter] = useState("all");
  const [healthFilter, setHealthFilter] = useState("all");
  const [selectedPet, setSelectedPet] = useState<Pet | null>(null);

  const filteredPets = useMemo(() => {
    return pets.filter((pet) => {
      if (speciesFilter !== "all" && pet.species !== speciesFilter) return false;
      if (healthFilter !== "all" && pet.healthStatus !== healthFilter) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const owner = owners.find((o) => o.id === pet.ownerId);
        const matchName = pet.name.toLowerCase().includes(q);
        const matchBreed = pet.breed.toLowerCase().includes(q);
        const matchOwner = owner?.fullName.toLowerCase().includes(q) || owner?.phone.includes(q);
        const matchChip = pet.microchipId?.toLowerCase().includes(q);
        if (!matchName && !matchBreed && !matchOwner && !matchChip) return false;
      }

      return true;
    });
  }, [pets, speciesFilter, healthFilter, searchQuery, owners]);

  const selectedOwner = selectedPet ? owners.find((o) => o.id === selectedPet.ownerId) : null;
  const selectedPetRecords = selectedPet ? medicalRecords.filter((r) => r.petId === selectedPet.id) : [];
  const selectedPetAppointments = selectedPet ? appointments.filter((a) => a.petId === selectedPet.id) : [];

  return (
    <AdminLayout title="Quản lý thú cưng">
      {/* Filters */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center gap-4">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Tìm theo tên, giống, chủ nhân, microchip..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm focus:border-primary focus:outline-none shadow-xs"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Species Filter */}
        <div className="flex items-center gap-2">
          {SPECIES_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSpeciesFilter(opt.key)}
              className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                speciesFilter === opt.key
                  ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Health Filter */}
        <select
          value={healthFilter}
          onChange={(e) => setHealthFilter(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 focus:border-primary focus:outline-none"
        >
          {HEALTH_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              Sức khỏe: {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5">
          <p className="text-slate-500">{filteredPets.length} / {pets.length} thú cưng</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
              <tr>
                <th className="px-6 py-4">Thú cưng</th>
                <th className="px-6 py-4">Loài / Giống</th>
                <th className="px-6 py-4">Tuổi / Cân nặng</th>
                <th className="px-6 py-4">Chủ nhân</th>
                <th className="px-6 py-4">Tình trạng</th>
                <th className="px-6 py-4">Microchip</th>
                <th className="px-6 py-4 text-right">Chi tiết</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPets.map(pet => {
                const owner = owners.find(o => o.id === pet.ownerId);
                return (
                  <tr key={pet.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-lg">
                          {pet.species === "cat" ? "🐈" : pet.species === "dog" ? "🐕" : "🐾"}
                        </div>
                        <div>
                          <p className="font-bold text-slate-900">{pet.name}</p>
                          <p className="text-xs text-slate-400 capitalize">{pet.gender}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-slate-800 capitalize">{pet.species}</p>
                      <p className="text-xs text-slate-400">{pet.breed}</p>
                    </td>
                    <td className="px-6 py-4 text-slate-700">
                      <p>{pet.ageLabel}</p>
                      {pet.weightKg && <p className="text-xs text-slate-400">{pet.weightKg} kg</p>}
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-slate-800">{owner?.fullName ?? "—"}</p>
                      <p className="text-xs text-slate-400">{owner?.phone}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`rounded-lg px-2.5 py-1 text-xs font-bold ${statusColors[pet.healthStatus] ?? "bg-slate-100 text-slate-600"}`}>
                        {statusLabels[pet.healthStatus] ?? pet.healthStatus}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-500 font-mono">{pet.microchipId ?? "—"}</td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => setSelectedPet(pet)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Eye size={14} className="text-primary" /> Xem
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filteredPets.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-slate-400">
                    Không tìm thấy thú cưng phù hợp.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pet Detail Modal */}
      {selectedPet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4">
          <div className="my-8 w-full max-w-2xl animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 mb-6 border-b border-slate-100">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-3xl">
                  {selectedPet.species === "cat" ? "🐈" : "🐕"}
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-900">{selectedPet.name}</h2>
                  <p className="text-sm text-slate-500">{selectedPet.breed} · {selectedPet.ageLabel} · {selectedPet.gender}</p>
                </div>
              </div>
              <button onClick={() => setSelectedPet(null)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg">
                <X size={20} />
              </button>
            </div>

            {/* Pet Info Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
                <p className="text-[11px] font-bold text-slate-400 uppercase">Cân nặng</p>
                <p className="text-lg font-black text-slate-900 flex items-center justify-center gap-1">
                  <Weight size={14} className="text-slate-400" /> {selectedPet.weightKg ?? "—"} kg
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
                <p className="text-[11px] font-bold text-slate-400 uppercase">Sức khỏe</p>
                <span className={`inline-block mt-1 rounded-lg px-2.5 py-1 text-xs font-bold ${statusColors[selectedPet.healthStatus] ?? "bg-slate-100 text-slate-600"}`}>
                  {statusLabels[selectedPet.healthStatus] ?? selectedPet.healthStatus}
                </span>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
                <p className="text-[11px] font-bold text-slate-400 uppercase">Microchip</p>
                <p className="text-xs font-mono font-bold text-slate-700 mt-1">{selectedPet.microchipId ?? "Không có"}</p>
              </div>
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-center">
                <p className="text-[11px] font-bold text-slate-400 uppercase">Dị ứng</p>
                <p className="text-xs font-bold text-slate-700 mt-1">{selectedPet.allergies?.join(", ") || "Không"}</p>
              </div>
            </div>

            {/* Owner Info */}
            {selectedOwner && (
              <div className="rounded-xl bg-blue-50/50 border border-blue-100 p-4 mb-6">
                <p className="text-xs font-bold uppercase tracking-wider text-blue-400 mb-2">Thông tin chủ nhân</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="font-bold text-slate-900">{selectedOwner.fullName}</p>
                    <p className="text-xs text-slate-500">{selectedOwner.email}</p>
                  </div>
                  <div>
                    <p className="text-slate-700">📞 {selectedOwner.phone}</p>
                    <p className="text-xs text-slate-500">{selectedOwner.address}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Recent Medical Records */}
            <div className="mb-4">
              <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2">
                <FileText size={14} className="text-primary" /> Bệnh án gần đây ({selectedPetRecords.length})
              </h3>
              {selectedPetRecords.length > 0 ? (
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {selectedPetRecords.slice(0, 5).map((r) => (
                    <div key={r.id} className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-slate-800">{r.title}</p>
                        <span className="text-xs text-slate-400">{r.visitDate}</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{r.doctorName} · {r.diagnosis}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400">Chưa có bệnh án nào.</p>
              )}
            </div>

            {/* Recent Appointments */}
            <div className="mb-4">
              <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2">
                <Calendar size={14} className="text-indigo-600" /> Lịch khám ({selectedPetAppointments.length})
              </h3>
              {selectedPetAppointments.length > 0 ? (
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {selectedPetAppointments.slice(0, 4).map((a) => (
                    <div key={a.id} className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-100 p-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{a.serviceName}</p>
                        <p className="text-xs text-slate-500">{a.date} · {a.time}</p>
                      </div>
                      <span className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                        a.status === "confirmed" ? "bg-emerald-50 text-emerald-700" :
                        a.status === "pending" ? "bg-amber-50 text-amber-700" :
                        a.status === "completed" ? "bg-slate-100 text-slate-600" :
                        "bg-rose-50 text-rose-700"
                      }`}>
                        {a.status === "confirmed" ? "Đã xác nhận" :
                         a.status === "pending" ? "Chờ" :
                         a.status === "completed" ? "Hoàn thành" :
                         "Đã hủy"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400">Chưa có lịch khám nào.</p>
              )}
            </div>

            <div className="pt-4 border-t border-slate-100 text-right">
              <button
                onClick={() => setSelectedPet(null)}
                className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-bold text-white hover:bg-slate-800"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
