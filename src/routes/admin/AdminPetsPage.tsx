import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";

export function AdminPetsPage() {
  const { pets, owners } = useAppStore();

  return (
    <AdminLayout title="Quản lý thú cưng">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-slate-100 px-6 py-5">
          <p className="text-slate-500">{pets.length} thú cưng trong hệ thống</p>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pets.map(pet => {
                const owner = owners.find(o => o.id === pet.ownerId);
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}