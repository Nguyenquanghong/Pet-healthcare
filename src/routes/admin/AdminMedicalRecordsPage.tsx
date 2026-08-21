import { useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout";
import { RecordList } from "../../components/shared/RecordList";
import { Card } from "../../components/ui/Card";
import { useAppStore } from "../../store/AppStoreProvider";

export function AdminMedicalRecordsPage() {
  const { appointments, createMedicalRecord, pets } = useAppStore();
  const completedAppointments = appointments.filter((appointment) => ["checked_in", "in_progress", "completed"].includes(appointment.status));
  const [petId, setPetId] = useState(pets[0]?.id ?? "");
  const [appointmentId, setAppointmentId] = useState("");
  const [title, setTitle] = useState("Khám và cập nhật hồ sơ");
  const [symptoms, setSymptoms] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [treatment, setTreatment] = useState("");
  const [medications, setMedications] = useState("");
  const [followUpDate, setFollowUpDate] = useState("2026-12-01");
  const [weightKg, setWeightKg] = useState("8.4");
  const [temperatureC, setTemperatureC] = useState("38.2");
  const [heartRateBpm, setHeartRateBpm] = useState("92");

  const submitRecord = () => {
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
      followUpDate,
      weightKg: Number(weightKg) || undefined,
      temperatureC: Number(temperatureC) || undefined,
      heartRateBpm: Number(heartRateBpm) || undefined,
    });
  };

  return (
    <AppLayout type="admin" title="Quản lý hồ sơ y tế">
      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card title="Create Medical Record">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-sm font-bold text-slate-600">Pet</span>
              <select className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={petId} onChange={(event) => setPetId(event.target.value)}>
                {pets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name} - {pet.breed}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-600">Appointment</span>
              <select className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={appointmentId} onChange={(event) => setAppointmentId(event.target.value)}>
                <option value="">Không liên kết</option>
                {completedAppointments.map((appointment) => <option key={appointment.id} value={appointment.id}>{appointment.date} {appointment.time} - {appointment.serviceName}</option>)}
              </select>
            </label>
          </div>
          <label className="mt-4 block"><span className="text-sm font-bold text-slate-600">Tiêu đề</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="mt-4 block"><span className="text-sm font-bold text-slate-600">Triệu chứng</span><textarea className="mt-2 min-h-20 w-full rounded-xl border border-slate-200 px-4 py-3" value={symptoms} onChange={(event) => setSymptoms(event.target.value)} /></label>
          <label className="mt-4 block"><span className="text-sm font-bold text-slate-600">Chẩn đoán</span><textarea className="mt-2 min-h-20 w-full rounded-xl border border-slate-200 px-4 py-3" value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} /></label>
          <label className="mt-4 block"><span className="text-sm font-bold text-slate-600">Điều trị</span><textarea className="mt-2 min-h-20 w-full rounded-xl border border-slate-200 px-4 py-3" value={treatment} onChange={(event) => setTreatment(event.target.value)} /></label>
          <label className="mt-4 block"><span className="text-sm font-bold text-slate-600">Thuốc</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={medications} onChange={(event) => setMedications(event.target.value)} /></label>
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <label className="block"><span className="text-sm font-bold text-slate-600">Tái khám</span><input type="date" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} /></label>
            <label className="block"><span className="text-sm font-bold text-slate-600">Kg</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={weightKg} onChange={(event) => setWeightKg(event.target.value)} /></label>
            <label className="block"><span className="text-sm font-bold text-slate-600">°C</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={temperatureC} onChange={(event) => setTemperatureC(event.target.value)} /></label>
            <label className="block"><span className="text-sm font-bold text-slate-600">BPM</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={heartRateBpm} onChange={(event) => setHeartRateBpm(event.target.value)} /></label>
          </div>
          <button onClick={submitRecord} className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-bold text-white">Save Medical Record</button>
        </Card>
        <Card title="Medical Record Timeline">
          <RecordList />
        </Card>
      </div>
    </AppLayout>
  );
}
