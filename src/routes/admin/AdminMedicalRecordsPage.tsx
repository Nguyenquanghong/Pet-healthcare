import { useState } from "react";
import { CheckCircle2, FilePlus2 } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";

export function AdminMedicalRecordsPage() {
  const { appointments, createMedicalRecord, pets, medicalRecords, owners } = useAppStore();
  const completedAppointments = appointments.filter(a => ["checked_in", "in_progress", "confirmed"].includes(a.status));

  const [showForm, setShowForm] = useState(false);
  const [petId, setPetId] = useState(pets[0]?.id ?? "");
  const [appointmentId, setAppointmentId] = useState("");
  const [title, setTitle] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [treatment, setTreatment] = useState("");
  const [medications, setMedications] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [temperatureC, setTemperatureC] = useState("");
  const [heartRateBpm, setHeartRateBpm] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const resetForm = () => {
    setTitle(""); setSymptoms(""); setDiagnosis(""); setTreatment("");
    setMedications(""); setFollowUpDate(""); setWeightKg(""); setTemperatureC(""); setHeartRateBpm("");
    setAppointmentId("");
    setShowForm(false);
  };

  const handleSubmit = () => {
    if (!petId || !title || !diagnosis || !treatment) return;
    createMedicalRecord({
      petId,
      appointmentId: appointmentId || undefined,
      doctorName: "Bs. Mai Nguyễn",
      visitDate: new Date().toISOString().slice(0, 10),
      title,
      symptoms,
      diagnosis,
      treatment,
      medications,
      followUpDate: followUpDate || undefined,
      weightKg: Number(weightKg) || undefined,
      temperatureC: Number(temperatureC) || undefined,
      heartRateBpm: Number(heartRateBpm) || undefined,
    });
    setSuccessMsg("Đã tạo hồ sơ y tế thành công. Thông báo đã được gửi đến chủ thú cưng.");
    setTimeout(() => setSuccessMsg(""), 4000);
    resetForm();
  };

  const fieldCls = "w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary bg-white";
  const labelCls = "block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5";

  return (
    <AdminLayout title="Hồ sơ y tế">
      {successMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold">
          <CheckCircle2 size={18} /> {successMsg}
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <p className="text-slate-500">{medicalRecords.length} hồ sơ tổng cộng</p>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-white hover:bg-primary-dark transition-colors shadow-soft"
        >
          <FilePlus2 size={16} />
          {showForm ? "Đóng form" : "Tạo hồ sơ mới"}
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="mb-8 rounded-2xl border border-primary/20 bg-white p-6 shadow-soft">
          <h2 className="mb-6 text-xl font-bold text-slate-900">Tạo hồ sơ y tế mới</h2>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className={labelCls}>Thú cưng</label>
              <select className={fieldCls} value={petId} onChange={e => setPetId(e.target.value)}>
                {pets.map(p => <option key={p.id} value={p.id}>{p.name} — {p.breed}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Liên kết lịch khám</label>
              <select className={fieldCls} value={appointmentId} onChange={e => setAppointmentId(e.target.value)}>
                <option value="">Không liên kết</option>
                {completedAppointments.map(a => <option key={a.id} value={a.id}>{a.date} {a.time} — {a.serviceName}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Tiêu đề *</label>
              <input className={fieldCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="VD: Khám tổng quát định kỳ" />
            </div>
            <div>
              <label className={labelCls}>Triệu chứng</label>
              <textarea className={`${fieldCls} min-h-24`} value={symptoms} onChange={e => setSymptoms(e.target.value)} placeholder="Mô tả triệu chứng..." />
            </div>
            <div>
              <label className={labelCls}>Chẩn đoán *</label>
              <textarea className={`${fieldCls} min-h-24`} value={diagnosis} onChange={e => setDiagnosis(e.target.value)} placeholder="Kết quả chẩn đoán..." />
            </div>
            <div>
              <label className={labelCls}>Phương pháp điều trị *</label>
              <textarea className={`${fieldCls} min-h-24`} value={treatment} onChange={e => setTreatment(e.target.value)} placeholder="Hướng điều trị..." />
            </div>
            <div>
              <label className={labelCls}>Thuốc kê đơn</label>
              <textarea className={`${fieldCls} min-h-24`} value={medications} onChange={e => setMedications(e.target.value)} placeholder="Danh sách thuốc..." />
            </div>
            <div>
              <label className={labelCls}>Ngày tái khám</label>
              <input type="date" className={fieldCls} value={followUpDate} onChange={e => setFollowUpDate(e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Cân nặng (kg)</label>
                <input type="number" className={fieldCls} value={weightKg} onChange={e => setWeightKg(e.target.value)} placeholder="32.4" />
              </div>
              <div>
                <label className={labelCls}>Nhiệt độ (°C)</label>
                <input type="number" className={fieldCls} value={temperatureC} onChange={e => setTemperatureC(e.target.value)} placeholder="38.5" />
              </div>
              <div>
                <label className={labelCls}>Nhịp tim (bpm)</label>
                <input type="number" className={fieldCls} value={heartRateBpm} onChange={e => setHeartRateBpm(e.target.value)} placeholder="88" />
              </div>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button onClick={resetForm} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors">
              Hủy
            </button>
            <button
              onClick={handleSubmit}
              disabled={!petId || !title || !diagnosis || !treatment}
              className="rounded-xl bg-primary px-6 py-3 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-soft"
            >
              Lưu hồ sơ y tế
            </button>
          </div>
        </div>
      )}

      {/* Records List */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
              <tr>
                <th className="px-6 py-4">Ngày khám</th>
                <th className="px-6 py-4">Thú cưng</th>
                <th className="px-6 py-4">Chủ nhân</th>
                <th className="px-6 py-4">Tiêu đề</th>
                <th className="px-6 py-4">Bác sĩ</th>
                <th className="px-6 py-4">Tái khám</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {medicalRecords.map(r => {
                const pet = pets.find(p => p.id === r.petId);
                const owner = owners.find(o => o.id === r.ownerId);
                return (
                  <tr key={r.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4 font-semibold text-slate-900">{r.visitDate}</td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-slate-900">{pet?.name}</p>
                      <p className="text-xs text-slate-400">{pet?.breed}</p>
                    </td>
                    <td className="px-6 py-4 text-slate-700">{owner?.fullName}</td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-slate-900">{r.title}</p>
                      <p className="text-xs text-slate-400 line-clamp-1">{r.diagnosis}</p>
                    </td>
                    <td className="px-6 py-4 text-slate-600">{r.doctorName}</td>
                    <td className="px-6 py-4 text-slate-600">{r.followUpDate ?? "—"}</td>
                  </tr>
                );
              })}
              {medicalRecords.length === 0 && (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-400">Chưa có hồ sơ y tế.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
