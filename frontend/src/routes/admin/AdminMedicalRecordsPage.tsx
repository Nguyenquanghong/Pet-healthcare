import { useMemo, useState, type ChangeEvent } from "react";
import {
  CheckCircle2,
  FilePlus2,
  Search,
  Pencil,
  Trash2,
  Eye,
  X,
  Stethoscope,
  HeartPulse,
  Calendar,
  AlertCircle,
  FileText,
  ImagePlus,
  Trash,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import {
  createMedicalRecord as createMedicalRecordRequest,
  deleteMedicalRecord as deleteMedicalRecordRequest,
  updateMedicalRecord as updateMedicalRecordRequest,
} from "../../services/medicalRecordService";
import { useAppStore } from "../../store/AppStoreProvider";
import type { MedicalRecord } from "../../types/medicalRecord";

export function AdminMedicalRecordsPage() {
  const {
    appointments,
    createMedicalRecord: createMedicalRecordInStore,
    updateMedicalRecord: updateMedicalRecordInStore,
    deleteMedicalRecord: deleteMedicalRecordInStore,
    deleteMedicalImage,
    uploadMedicalImage,
    pets,
    medicalImages,
    medicalRecords,
    owners,
  } = useAppStore();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImageForm, setShowImageForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPetFilter, setSelectedPetFilter] = useState("all");

  // Form states for Create & Edit
  const [editRecord, setEditRecord] = useState<MedicalRecord | null>(null);
  const [deleteConfirmRecord, setDeleteConfirmRecord] = useState<MedicalRecord | null>(null);
  const [viewDetailRecord, setViewDetailRecord] = useState<MedicalRecord | null>(null);

  // Form inputs
  const [petId, setPetId] = useState(pets[0]?.id ?? "");
  const [appointmentId, setAppointmentId] = useState("");
  const [title, setTitle] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [treatment, setTreatment] = useState("");
  const [medications, setMedications] = useState("");
  const [vaccineName, setVaccineName] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [temperatureC, setTemperatureC] = useState("");
  const [heartRateBpm, setHeartRateBpm] = useState("");
  const [doctorName, setDoctorName] = useState("Bs. Mai Nguyễn");
  const [imagePetId, setImagePetId] = useState(pets[0]?.id ?? "");
  const [imageTitle, setImageTitle] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [imageMimeType, setImageMimeType] = useState("");

  const [toastMsg, setToastMsg] = useState("");
  const [formError, setFormError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const resetForm = () => {
    setTitle("");
    setSymptoms("");
    setDiagnosis("");
    setTreatment("");
    setMedications("");
    setVaccineName("");
    setFollowUpDate("");
    setWeightKg("");
    setTemperatureC("");
    setHeartRateBpm("");
    setAppointmentId("");
    setDoctorName("Bs. Mai Nguyễn");
    setFormError("");
    setShowCreateForm(false);
    setEditRecord(null);
  };

  const openEdit = (r: MedicalRecord) => {
    setEditRecord(r);
    setPetId(r.petId);
    setAppointmentId(r.appointmentId ?? "");
    setTitle(r.title);
    setSymptoms(r.symptoms ?? "");
    setDiagnosis(r.diagnosis);
    setTreatment(r.treatment);
    setMedications(r.medications ?? "");
    setVaccineName(r.vaccineName ?? "");
    setFollowUpDate(r.followUpDate ?? "");
    setWeightKg(r.weightKg ? String(r.weightKg) : "");
    setTemperatureC(r.temperatureC ? String(r.temperatureC) : "");
    setHeartRateBpm(r.heartRateBpm ? String(r.heartRateBpm) : "");
    setDoctorName(r.doctorName ?? "Bs. Mai Nguyễn");
    setFormError("");
  };

  const handleCreateSubmit = async () => {
    setFormError("");
    setIsSubmitting(true);
    try {
      await createMedicalRecordRequest(
        {
          petId,
          appointmentId: appointmentId || undefined,
          doctorName,
          visitDate: new Date().toISOString().slice(0, 10),
          title,
          symptoms,
          diagnosis,
          treatment,
          medications,
          vaccineName: vaccineName || undefined,
          followUpDate: followUpDate || undefined,
          weightKg: Number(weightKg) || undefined,
          temperatureC: Number(temperatureC) || undefined,
          heartRateBpm: Number(heartRateBpm) || undefined,
        },
        createMedicalRecordInStore,
      );
      toast("Đã tạo hồ sơ y tế thành công.");
      resetForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Không thể tạo hồ sơ y tế.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!editRecord) return;
    setFormError("");
    setIsSubmitting(true);
    try {
      await updateMedicalRecordRequest(
        editRecord.id,
        {
          petId,
          appointmentId: appointmentId || undefined,
          doctorName,
          title,
          symptoms,
          diagnosis,
          treatment,
          medications,
          vaccineName: vaccineName || undefined,
          followUpDate: followUpDate || undefined,
          weightKg: Number(weightKg) || undefined,
          temperatureC: Number(temperatureC) || undefined,
          heartRateBpm: Number(heartRateBpm) || undefined,
        },
        updateMedicalRecordInStore,
      );
      toast("Đã cập nhật hồ sơ y tế thành công.");
      resetForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Không thể cập nhật hồ sơ y tế.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteSubmit = async () => {
    if (!deleteConfirmRecord) return;
    setFormError("");
    setIsSubmitting(true);
    try {
      await deleteMedicalRecordRequest(deleteConfirmRecord.id, deleteMedicalRecordInStore);
      setDeleteConfirmRecord(null);
      toast("Đã xóa hồ sơ y tế.");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Không thể xóa hồ sơ y tế.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImageFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setFormError("Please select an image file (JPG, PNG, or WEBP).");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFormError("Diagnostic images must not exceed 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(String(reader.result));
      setImageMimeType(file.type);
      if (!imageTitle.trim()) setImageTitle(file.name.replace(/\.[^.]+$/, ""));
      setFormError("");
    };
    reader.onerror = () => setFormError("Unable to read the image. Please try again.");
    reader.readAsDataURL(file);
  };

  const handleImageUpload = () => {
    if (!imagePetId || !imageDataUrl || !imageTitle.trim()) {
      setFormError("Select a pet, enter an image title, and choose an image to upload.");
      return;
    }
    uploadMedicalImage({ petId: imagePetId, title: imageTitle.trim(), imageUrl: imageDataUrl, mimeType: imageMimeType });
    setImageTitle("");
    setImageDataUrl("");
    setImageMimeType("");
    setShowImageForm(false);
    setFormError("");
    toast("Diagnostic image uploaded successfully.");
  };

  const imageList = useMemo(
    () => medicalImages.filter((image) => image.petId === imagePetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [medicalImages, imagePetId],
  );

  // Completed/in_progress appointments for suggestion
  const relevantAppointments = useMemo(() => {
    return appointments.filter((a) => a.petId === petId);
  }, [appointments, petId]);

  const filteredRecords = useMemo(() => {
    return medicalRecords.filter((r) => {
      if (selectedPetFilter !== "all" && r.petId !== selectedPetFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const pet = pets.find((p) => p.id === r.petId);
        const owner = owners.find((o) => o.id === r.ownerId);

        const matchTitle = r.title.toLowerCase().includes(q);
        const matchDiagnosis = r.diagnosis.toLowerCase().includes(q);
        const matchPet = pet?.name.toLowerCase().includes(q) || pet?.breed.toLowerCase().includes(q);
        const matchOwner = owner?.fullName.toLowerCase().includes(q);
        const matchDoctor = r.doctorName.toLowerCase().includes(q);

        if (!matchTitle && !matchDiagnosis && !matchPet && !matchOwner && !matchDoctor) return false;
      }
      return true;
    });
  }, [medicalRecords, selectedPetFilter, searchQuery, pets, owners]);

  const fieldCls =
    "w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none bg-white";
  const labelCls = "block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5";

  return (
    <AdminLayout title="Quản lý Hồ sơ y tế">
      {toastMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} /> {toastMsg}
        </div>
      )}
      {formError && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700">
          <AlertCircle size={18} /> {formError}
        </div>
      )}

      {/* Header bar */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-1 max-w-xl">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm kiếm theo tiêu đề, chẩn đoán, thú cưng, bác sĩ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <select
            value={selectedPetFilter}
            onChange={(e) => setSelectedPetFilter(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold focus:border-primary focus:outline-none"
          >
            <option value="all">Tất cả thú cưng ({medicalRecords.length})</option>
            {pets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.breed})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setShowImageForm((value) => !value)}
            disabled={isSubmitting}
            className="flex items-center gap-2 rounded-xl border border-primary/30 bg-white px-5 py-2.5 text-sm font-bold text-primary hover:bg-slate-50 transition-colors"
          >
            <ImagePlus size={16} />
            {showImageForm ? "Close upload" : "Upload diagnostic image"}
          </button>
        <button
          onClick={() => {
            resetForm();
            setShowCreateForm((v) => !v);
          }}
          disabled={isSubmitting}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-dark transition-colors shadow-soft"
        >
          <FilePlus2 size={16} />
          {showCreateForm ? "Đóng form" : "Tạo hồ sơ mới"}
        </button>
        </div>
      </div>

      {showImageForm && (
        <div className="mb-8 rounded-2xl border border-primary/20 bg-white p-6 shadow-soft animate-scaleUp">
          <div className="mb-5 flex items-center gap-2">
            <ImagePlus size={20} className="text-primary" />
            <div>
              <h2 className="text-xl font-bold text-slate-900">Upload diagnostic image</h2>
              <p className="mt-1 text-sm text-slate-500">Upload X-ray, ultrasound, or microscope images. The owner can view them from the pet profile.</p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={labelCls}>Pet *</label>
              <select className={fieldCls} value={imagePetId} onChange={(event) => setImagePetId(event.target.value)}>
                {pets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name} - {pet.breed}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Image title *</label>
              <input className={fieldCls} value={imageTitle} onChange={(event) => setImageTitle(event.target.value)} placeholder="Example: Chest X-ray" />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Image file * (JPG, PNG, WEBP; max 5 MB)</label>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageFileChange} className={fieldCls} />
            </div>
          </div>
          {imageDataUrl && <img src={imageDataUrl} alt="Diagnostic image preview" className="mt-4 h-48 w-full rounded-xl border border-slate-200 bg-slate-50 object-contain" />}
          <div className="mt-6 flex justify-end gap-3 border-t border-slate-100 pt-3">
            <button onClick={() => { setShowImageForm(false); setImageDataUrl(""); }} className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">Cancel</button>
            <button onClick={handleImageUpload} className="rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-white hover:bg-primary-dark shadow-soft">Save image</button>
          </div>
          {imageList.length > 0 && (
            <div className="mt-6 border-t border-slate-100 pt-5">
              <p className="mb-3 text-sm font-bold text-slate-900">Uploaded images ({imageList.length})</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {imageList.map((image) => (
                  <div key={image.id} className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                    <img src={image.imageUrl} alt={image.title} className="h-24 w-full object-cover" />
                    <p className="truncate px-2 py-1.5 text-xs font-semibold text-slate-700">{image.title}</p>
                    <button type="button" onClick={() => deleteMedicalImage(image.id)} className="absolute right-1.5 top-1.5 rounded-md bg-white/95 p-1.5 text-rose-600 shadow-sm hover:bg-rose-50" aria-label={`Delete ${image.title}`}><Trash size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Form */}
      {showCreateForm && (
        <div className="mb-8 rounded-2xl border border-primary/20 bg-white p-6 shadow-soft animate-scaleUp">
          <h2 className="mb-5 text-xl font-bold text-slate-900 flex items-center gap-2">
            <FilePlus2 size={20} className="text-primary" />
            Tạo hồ sơ y tế mới
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={labelCls}>Chọn Thú cưng *</label>
              <select className={fieldCls} value={petId} onChange={(e) => setPetId(e.target.value)}>
                {pets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.breed} (Chủ: {owners.find((o) => o.id === p.ownerId)?.fullName})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>Liên kết lịch khám</label>
              <select className={fieldCls} value={appointmentId} onChange={(e) => setAppointmentId(e.target.value)}>
                <option value="">Không liên kết (Khám tự do)</option>
                {relevantAppointments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.date} {a.time} — {a.serviceName} ({a.status})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>Tiêu đề hồ sơ *</label>
              <input
                className={fieldCls}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="VD: Khám tổng quát định kỳ"
              />
            </div>

            <div>
              <label className={labelCls}>Bác sĩ khám *</label>
              <input
                className={fieldCls}
                value={doctorName}
                onChange={(e) => setDoctorName(e.target.value)}
                placeholder="Bs. Mai Nguyễn"
              />
            </div>

            <div>
              <label className={labelCls}>Triệu chứng</label>
              <textarea
                className={`${fieldCls} min-h-20`}
                value={symptoms}
                onChange={(e) => setSymptoms(e.target.value)}
                placeholder="Mô tả triệu chứng lâm sàng..."
              />
            </div>

            <div>
              <label className={labelCls}>Chẩn đoán y khoa *</label>
              <textarea
                className={`${fieldCls} min-h-20`}
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                placeholder="Kết quả chẩn đoán..."
              />
            </div>

            <div>
              <label className={labelCls}>Phương pháp điều trị *</label>
              <textarea
                className={`${fieldCls} min-h-20`}
                value={treatment}
                onChange={(e) => setTreatment(e.target.value)}
                placeholder="Hướng điều trị..."
              />
            </div>

            <div>
              <label className={labelCls}>Thuốc kê đơn</label>
              <textarea
                className={`${fieldCls} min-h-20`}
                value={medications}
                onChange={(e) => setMedications(e.target.value)}
                placeholder="Danh sách thuốc và liều dùng..."
              />
            </div>

            <div>
              <label className={labelCls}>Tên Vaccine (nếu có)</label>
              <input
                className={fieldCls}
                value={vaccineName}
                onChange={(e) => setVaccineName(e.target.value)}
                placeholder="VD: DHPPi + Lepto"
              />
            </div>

            <div>
              <label className={labelCls}>Ngày hẹn tái khám</label>
              <input
                type="date"
                className={fieldCls}
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3 md:col-span-2">
              <div>
                <label className={labelCls}>Cân nặng (kg)</label>
                <input
                  type="number"
                  step="0.1"
                  className={fieldCls}
                  value={weightKg}
                  onChange={(e) => setWeightKg(e.target.value)}
                  placeholder="8.5"
                />
              </div>
              <div>
                <label className={labelCls}>Nhiệt độ (°C)</label>
                <input
                  type="number"
                  step="0.1"
                  className={fieldCls}
                  value={temperatureC}
                  onChange={(e) => setTemperatureC(e.target.value)}
                  placeholder="38.5"
                />
              </div>
              <div>
                <label className={labelCls}>Nhịp tim (bpm)</label>
                <input
                  type="number"
                  className={fieldCls}
                  value={heartRateBpm}
                  onChange={(e) => setHeartRateBpm(e.target.value)}
                  placeholder="92"
                />
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              onClick={resetForm}
              disabled={isSubmitting}
              className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              Hủy
            </button>
            <button
              onClick={handleCreateSubmit}
              disabled={isSubmitting}
              className="rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 transition-colors shadow-soft"
            >
              {isSubmitting ? "Đang lưu..." : "Lưu hồ sơ y tế"}
            </button>
          </div>
        </div>
      )}

      {/* Records List Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
              <tr>
                <th className="px-5 py-4">Ngày khám</th>
                <th className="px-5 py-4">Thú cưng & Chủ nhân</th>
                <th className="px-5 py-4">Tiêu đề & Chẩn đoán</th>
                <th className="px-5 py-4">Bác sĩ</th>
                <th className="px-5 py-4">Sinh hiệu & Vaccine</th>
                <th className="px-5 py-4 text-right">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRecords.map((r) => {
                const pet = pets.find((p) => p.id === r.petId);
                const owner = owners.find((o) => o.id === r.ownerId);

                return (
                  <tr key={r.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-5 py-4 whitespace-nowrap font-bold text-slate-900">
                      {r.visitDate}
                    </td>

                    <td className="px-5 py-4">
                      <p className="font-bold text-slate-900">{pet?.name}</p>
                      <p className="text-xs text-slate-500">
                        {pet?.breed} &bull; Chủ: {owner?.fullName}
                      </p>
                    </td>

                    <td className="px-5 py-4">
                      <p className="font-semibold text-slate-900">{r.title}</p>
                      <p className="text-xs text-slate-500 line-clamp-1">{r.diagnosis}</p>
                    </td>

                    <td className="px-5 py-4 text-slate-700 whitespace-nowrap">{r.doctorName}</td>

                    <td className="px-5 py-4 whitespace-nowrap text-xs">
                      <div className="space-y-0.5">
                        {r.weightKg && <span>{r.weightKg} kg</span>}
                        {r.temperatureC && <span> &bull; {r.temperatureC}°C</span>}
                        {r.vaccineName && (
                          <p className="text-slate-500 font-semibold">💉 {r.vaccineName}</p>
                        )}
                      </div>
                    </td>

                    <td className="px-5 py-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setViewDetailRecord(r)}
                          title="Xem chi tiết"
                          className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          onClick={() => openEdit(r)}
                          title="Chỉnh sửa"
                          className="rounded-lg bg-blue-50 border border-blue-200 p-2 text-blue-700 hover:bg-blue-100 transition-colors"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => setDeleteConfirmRecord(r)}
                          title="Xóa hồ sơ"
                          className="rounded-lg bg-rose-50 border border-rose-200 p-2 text-rose-700 hover:bg-rose-100 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredRecords.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    Không tìm thấy hồ sơ y tế nào.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Record Modal */}
      {editRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
          <div className="my-8 max-h-[90vh] w-full max-w-2xl animate-scaleUp overflow-y-auto rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <Pencil size={20} className="text-primary" />
                Chỉnh sửa hồ sơ y tế
              </h3>
              <button onClick={resetForm} disabled={isSubmitting} className="text-slate-400 hover:text-slate-600 rounded-lg p-1">
                <X size={20} />
              </button>
            </div>

            <div className="my-4 grid gap-4 md:grid-cols-2">
              <div>
                <label className={labelCls}>Thú cưng</label>
                <select className={fieldCls} value={petId} onChange={(e) => setPetId(e.target.value)}>
                  {pets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.breed}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelCls}>Bác sĩ phụ trách</label>
                <input
                  className={fieldCls}
                  value={doctorName}
                  onChange={(e) => setDoctorName(e.target.value)}
                />
              </div>

              <div className="md:col-span-2">
                <label className={labelCls}>Tiêu đề hồ sơ *</label>
                <input className={fieldCls} value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>

              <div>
                <label className={labelCls}>Triệu chứng</label>
                <textarea
                  className={`${fieldCls} min-h-20`}
                  value={symptoms}
                  onChange={(e) => setSymptoms(e.target.value)}
                />
              </div>

              <div>
                <label className={labelCls}>Chẩn đoán *</label>
                <textarea
                  className={`${fieldCls} min-h-20`}
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                />
              </div>

              <div>
                <label className={labelCls}>Hướng điều trị *</label>
                <textarea
                  className={`${fieldCls} min-h-20`}
                  value={treatment}
                  onChange={(e) => setTreatment(e.target.value)}
                />
              </div>

              <div>
                <label className={labelCls}>Thuốc kê đơn</label>
                <textarea
                  className={`${fieldCls} min-h-20`}
                  value={medications}
                  onChange={(e) => setMedications(e.target.value)}
                />
              </div>

              <div>
                <label className={labelCls}>Tên Vaccine</label>
                <input
                  className={fieldCls}
                  value={vaccineName}
                  onChange={(e) => setVaccineName(e.target.value)}
                />
              </div>

              <div>
                <label className={labelCls}>Ngày hẹn tái khám</label>
                <input
                  type="date"
                  className={fieldCls}
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                />
              </div>

            <div className="grid gap-3 sm:grid-cols-3 md:col-span-2">
                <div>
                  <label className={labelCls}>Cân nặng (kg)</label>
                  <input
                    type="number"
                    step="0.1"
                    className={fieldCls}
                    value={weightKg}
                    onChange={(e) => setWeightKg(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Nhiệt độ (°C)</label>
                  <input
                    type="number"
                    step="0.1"
                    className={fieldCls}
                    value={temperatureC}
                    onChange={(e) => setTemperatureC(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Nhịp tim (bpm)</label>
                  <input
                    type="number"
                    className={fieldCls}
                    value={heartRateBpm}
                    onChange={(e) => setHeartRateBpm(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex gap-3 justify-end">
              <button
                onClick={resetForm}
                disabled={isSubmitting}
                className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                onClick={handleEditSubmit}
                disabled={isSubmitting}
                className="rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 transition-colors shadow-soft"
              >
                {isSubmitting ? "Đang cập nhật..." : "Cập nhật hồ sơ"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-rose-600 flex items-center gap-2">
                <AlertCircle size={20} />
                Xác nhận xóa hồ sơ y tế
              </h3>
              <button
                onClick={() => setDeleteConfirmRecord(null)}
                disabled={isSubmitting}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="my-4 text-sm text-slate-600 space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa hồ sơ y tế <strong>"{deleteConfirmRecord.title}"</strong> ngày{" "}
                <strong>{deleteConfirmRecord.visitDate}</strong> không?
              </p>
              <p className="text-xs text-rose-500 font-semibold">Hành động này không thể hoàn tác.</p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirmRecord(null)}
                disabled={isSubmitting}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                onClick={handleDeleteSubmit}
                disabled={isSubmitting}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isSubmitting ? "Đang xóa..." : "Xác nhận xóa"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Detail Modal */}
      {viewDetailRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
          <div className="my-8 max-h-[90vh] w-full max-w-xl animate-scaleUp overflow-y-auto rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <FileText size={20} className="text-primary" />
                Chi tiết hồ sơ bệnh án
              </h3>
              <button
                onClick={() => setViewDetailRecord(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={20} />
              </button>
            </div>

            <div className="my-4 space-y-4 text-sm">
              <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                <div>
                  <p className="font-bold text-slate-900 text-base">{viewDetailRecord.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Thú cưng:{" "}
                    <strong>{pets.find((p) => p.id === viewDetailRecord.petId)?.name}</strong> (
                    {pets.find((p) => p.id === viewDetailRecord.petId)?.breed})
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-slate-500">{viewDetailRecord.visitDate}</p>
                  <p className="text-xs font-bold text-primary">{viewDetailRecord.doctorName}</p>
                </div>
              </div>

              {(viewDetailRecord.weightKg || viewDetailRecord.temperatureC || viewDetailRecord.heartRateBpm) && (
                <div className="grid gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-center sm:grid-cols-3">
                  <div>
                    <p className="text-[11px] font-bold text-slate-400 uppercase">Cân nặng</p>
                    <p className="font-black text-slate-900 text-base">{viewDetailRecord.weightKg ?? "—"} kg</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-400 uppercase">Nhiệt độ</p>
                    <p className="font-black text-slate-900 text-base">
                      {viewDetailRecord.temperatureC ? `${viewDetailRecord.temperatureC}°C` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-400 uppercase">Nhịp tim</p>
                    <p className="font-black text-slate-900 text-base">
                      {viewDetailRecord.heartRateBpm ? `${viewDetailRecord.heartRateBpm} bpm` : "—"}
                    </p>
                  </div>
                </div>
              )}

              {viewDetailRecord.symptoms && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Triệu chứng
                  </p>
                  <p className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-700 leading-relaxed">
                    {viewDetailRecord.symptoms}
                  </p>
                </div>
              )}

              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Chẩn đoán</p>
                <p className="p-3 rounded-xl bg-slate-50 border border-slate-100 font-semibold text-slate-900 leading-relaxed">
                  {viewDetailRecord.diagnosis}
                </p>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Phương pháp điều trị
                </p>
                <p className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-700 leading-relaxed">
                  {viewDetailRecord.treatment}
                </p>
              </div>

              {viewDetailRecord.medications && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Thuốc kê đơn
                  </p>
                  <p className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-700 leading-relaxed">
                    {viewDetailRecord.medications}
                  </p>
                </div>
              )}

              {(viewDetailRecord.vaccineName || viewDetailRecord.followUpDate) && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {viewDetailRecord.vaccineName && (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">
                      💉 Vaccine: {viewDetailRecord.vaccineName}
                    </span>
                  )}
                  {viewDetailRecord.followUpDate && (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
                      Tái khám: {viewDetailRecord.followUpDate}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 text-right">
              <button
                onClick={() => setViewDetailRecord(null)}
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
