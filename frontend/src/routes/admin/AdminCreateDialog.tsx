import { usePagedList } from "../../services/usePagedList";
import { Pagination } from "../../components/ui/Pagination";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { Textarea } from "../../components/ui/Textarea";
import { appointmentServiceOptions, spaServiceOptions, hotelServiceOptions } from "../../data/services";
import { apiClient } from "../../services/apiClient";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Appointment, AppointmentType } from "../../types/appointment";
import type { HotelBooking, HotelRoomType, HotelServiceKey } from "../../types/booking";
import type { Pet } from "../../types/pet";
import type { Owner } from "../../types/owner";
import { calculateBookingTotal, calculateNights, ROOM_PRICES } from "../../utils/bookingCalculator";
import { formatCurrency } from "../../utils/formatCurrency";
import { ApiError } from "../../utils/apiError";
import { emptyPetDraft, genderLabels, healthLabels, PetDraftFields, speciesLabels } from "./PetDraftFields";
import { emptyOwnerDraft, OwnerDraftFields } from "./OwnerDraftFields";

type Kind = "pet" | "appointment" | "hotel";
const titles: Record<Kind, string> = { pet: "Thêm thú cưng", appointment: "Tạo lịch khám / Spa", hotel: "Tạo đặt phòng" };
const services = [...appointmentServiceOptions, ...spaServiceOptions];
const roomLabels: Record<HotelRoomType, string> = { standard: "Phòng tiêu chuẩn", deluxe: "Phòng cao cấp", vip: "Phòng VIP" };
const todayVietnam = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const phoneKey = (value: string) => {
  const digits = value.replace(/[\s.()-]/g, "");
  return /^\+?84\d{9}$/.test(digits) ? `0${digits.slice(-9)}` : digits;
};
function nextDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// All entry points share the same identity selection, confirmation and write feedback.
export function AdminCreateButton({ kind, onCreated }: { kind: Kind; onCreated?: () => void }) {
  const { userRole } = useAppStore();
  const [open, setOpen] = useState(false);
  if (userRole !== "admin" && userRole !== "staff") return null;
  return <>
    <Button type="button" icon={<Plus size={17} />} onClick={() => setOpen(true)}>{titles[kind]}</Button>
    {open && <AdminCreateDialog kind={kind} onClose={() => setOpen(false)} onCreated={onCreated} />}
  </>;
}

function AdminCreateDialog({ kind, onClose, onCreated }: { kind: Kind; onClose: () => void; onCreated?: () => void }) {
  const { refreshData } = useAppStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const hotelRequest = useRef<{ payload: string; key: string } | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [addedOwners, setAddedOwners] = useState<Owner[]>([]);
  const [addingOwner, setAddingOwner] = useState(false);
  const [ownerDraft, setOwnerDraft] = useState(emptyOwnerDraft);
  const [query, setQuery] = useState("");
  const [petId, setPetId] = useState("");
  const [addedPets, setAddedPets] = useState<Pet[]>([]);
  const [addingPet, setAddingPet] = useState(kind === "pet");
  const [petDraft, setPetDraft] = useState(emptyPetDraft);
  const [type, setType] = useState<AppointmentType>("general_checkup");
  const [date, setDate] = useState(todayVietnam);
  const [time, setTime] = useState("");
  const [checkIn, setCheckIn] = useState(todayVietnam);
  const [checkOut, setCheckOut] = useState(() => nextDay(todayVietnam()));
  const [roomType, setRoomType] = useState<HotelRoomType>("standard");
  const [serviceKeys, setServiceKeys] = useState<HotelServiceKey[]>([]);
  const [ownerNote, setOwnerNote] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [info, setInfo] = useState("");
  const [saved, setSaved] = useState<{ id: string; message: string } | null>(null);
  const [uncertainWrite, setUncertainWrite] = useState(false);
  const [ownerConflict, setOwnerConflict] = useState(false);
  const ownerPage = usePagedList<Owner>("/owners", { q: query });
  const petPage = usePagedList<Pet>("/pets", { ownerId }, Boolean(ownerId));
  const owners = ownerPage.items, pets = petPage.items;
  const allOwners = [...owners, ...addedOwners.filter(item => !owners.some(owner => owner.id === item.id))];
  const owner = allOwners.find(item => item.id === ownerId);
  const allPets = [...pets, ...addedPets.filter(item => !pets.some(pet => pet.id === item.id))];
  const ownerPets = allPets.filter(item => item.ownerId === ownerId);
  const pet = ownerPets.find(item => item.id === petId);
  const service = services.find(item => item.type === type)!;
  const nights = calculateNights(checkIn, checkOut);
  const total = calculateBookingTotal(roomType, serviceKeys, Math.max(0, nights));
  const filteredOwners = allOwners;
  const actionTitle = addingOwner ? "Tạo khách mới" : addingPet ? titles.pet : titles[kind];

  useEffect(() => { dialog.current?.showModal(); }, []);

  function validate() {
    if (addingOwner) {
      if (!ownerDraft.fullName.trim()) return "Nhập họ tên khách.";
      const phone = ownerDraft.phone.trim().replace(/[\s.()-]/g, "");
      if (!/^(?:0\d{9}|\+?84\d{9})$/.test(phone)) return "Nhập số điện thoại Việt Nam gồm 10 chữ số hoặc dạng +84.";
      return "";
    }
    if (!owner) return "Chọn khách đã có hoặc tạo hồ sơ khách mới.";
    if (addingPet) {
      if (!petDraft.name.trim()) return "Nhập tên thú cưng.";
      if (petDraft.weightKg && (!Number.isFinite(Number(petDraft.weightKg)) || Number(petDraft.weightKg) <= 0)) return "Cân nặng phải lớn hơn 0.";
    } else {
      if (!pet) return "Chọn thú cưng thuộc đúng chủ nuôi.";
      if (kind === "appointment" && (!date || date < todayVietnam() || !time)) return "Chọn ngày từ hôm nay và giờ hẹn.";
      if (kind === "hotel" && (!checkIn || !checkOut || checkIn < todayVietnam() || !Number.isFinite(nights) || nights < 1))
        return "Chọn ngày nhận từ hôm nay và ngày trả sau ngày nhận ít nhất một đêm.";
    }
    return "";
  }

  function reviewInput(event: FormEvent) {
    event.preventDefault();
    const message = validate();
    setError(message);
    if (!message) setReview(true);
  }

  async function reload() {
    try { await refreshData(); setWarning(""); return true; }
    catch {
      setWarning("Chưa tải lại được danh sách. Nếu đã lưu, không tạo lại; hãy mở lại trang khi kết nối ổn định.");
      return false;
    }
  }

  async function submit() {
    if (submitting.current || saved || uncertainWrite) return;
    const message = validate();
    if (message) { setError(message); setReview(false); return; }
    submitting.current = true;
    setBusy(true); setError(""); setOwnerConflict(false);
    try {
      if (addingOwner) {
        const { owner: created } = await apiClient.post<{ owner: Owner }>("/owners", {
          fullName: ownerDraft.fullName.trim(), phone: ownerDraft.phone.trim(), email: ownerDraft.email.trim(), address: ownerDraft.address.trim(),
        });
        setAddedOwners(items => [...items, created]); setOwnerId(created.id); setQuery(""); setPetId("");
        setAddingOwner(false); setAddingPet(true); setReview(false); setOwnerDraft(emptyOwnerDraft());
        setPetDraft(emptyPetDraft()); setInfo(`Đã tạo hồ sơ ${created.fullName}. Tiếp tục thêm thú cưng của khách.`);
      } else if (addingPet) {
        const { pet: created } = await apiClient.post<{ pet: Pet }>("/pets", {
          ownerId, name: petDraft.name.trim(), species: petDraft.species, gender: petDraft.gender,
          breed: petDraft.breed.trim(), ageLabel: petDraft.ageLabel.trim(),
          weightKg: petDraft.weightKg ? Number(petDraft.weightKg) : undefined,
          healthStatus: petDraft.healthStatus,
          allergies: petDraft.allergies.split(",").map(item => item.trim()).filter(Boolean), notes: petDraft.notes.trim(),
        });
        if (kind === "pet") {
          setSaved({ id: created.id, message: `Đã tạo thú cưng ${created.name} cho ${owner!.fullName}.` });
          onCreated?.();
        } else {
          setAddedPets(items => [...items, created]); setPetId(created.id);
          setAddingPet(false); setReview(false); setPetDraft(emptyPetDraft());
          setInfo(`Đã thêm ${created.name}. Tiếp tục nhập thông tin đặt dịch vụ.`);
        }
      } else if (kind === "appointment") {
        const { appointment } = await apiClient.post<{ appointment: Appointment }>("/appointments", {
          petId: pet!.id, type, serviceName: service.label, date, time, ownerNote: ownerNote.trim(),
        });
        setSaved({ id: appointment.id, message: "Đã tạo lịch ở trạng thái Chờ xác nhận. Tiếp tục xác nhận và check-in từ danh sách lịch hẹn." });
        onCreated?.();
      } else {
        const input = { petId: pet!.id, checkIn, checkOut, roomType, serviceKeys: [...serviceKeys].sort(), ownerNote: ownerNote.trim() };
        const payload = JSON.stringify(input);
        // A retry after a lost response must use the same key and payload.
        if (hotelRequest.current?.payload !== payload) hotelRequest.current = { payload, key: crypto.randomUUID() };
        const { booking } = await apiClient.post<{ booking: HotelBooking }>("/hotel-bookings", input, { "Idempotency-Key": hotelRequest.current.key });
        setSaved({ id: booking.id, message: `Đã tạo đặt phòng (${formatCurrency(booking.totalAmount)}) ở trạng thái Chờ xác nhận. Chốt phí và thanh toán vào cuối kỳ lưu trú.` });
        onCreated?.();
      }
      await reload();
    } catch (reason) {
      if ((addingOwner || addingPet || kind === "appointment") && reason instanceof ApiError && reason.httpStatus >= 500) {
        setUncertainWrite(true);
        setError("Chưa xác định yêu cầu đã được lưu hay chưa do mất kết nối hoặc lỗi máy chủ. Tải và kiểm tra danh sách trước khi tạo mới để tránh trùng.");
      } else {
        setError(reason instanceof Error ? reason.message : "Không lưu được dữ liệu. Vui lòng kiểm tra và thử lại.");
        if (addingOwner && reason instanceof ApiError && reason.httpStatus === 409) {
          setOwnerConflict(true); await reload();
        }
      }
    } finally { submitting.current = false; setBusy(false); }
  }

  return createPortal(
    <dialog ref={dialog} aria-labelledby="reception-dialog-title" onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}
      className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/50">
      <div className="p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="reception-dialog-title" className="text-xl font-bold">{saved ? "Đã lưu thành công" : review ? `Xác nhận: ${actionTitle}` : actionTitle}</h2>
          <button type="button" aria-label="Đóng form" disabled={busy} onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"><X size={20} /></button>
        </div>
        {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        {warning && <p role="alert" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{warning}</p>}
        {saved ? <div className="space-y-4">
          <p role="status" className="rounded-lg bg-emerald-50 p-4 text-emerald-800">{saved.message}</p>
          <p className="break-all text-sm">Mã: <strong>{saved.id}</strong></p>
          <div className="flex flex-wrap justify-end gap-3">
            {warning && <Button type="button" variant="outline" disabled={busy} onClick={async () => { setBusy(true); await reload(); setBusy(false); }}>Tải lại danh sách</Button>}
            <Button type="button" disabled={busy} onClick={onClose}>Đóng</Button>
          </div>
        </div> : review ? <div className="space-y-4">
          <div className="space-y-2 rounded-xl bg-slate-50 p-4 text-sm">
            {addingOwner ? <>
              <p className="text-base font-bold">Khách mới: {ownerDraft.fullName.trim()}</p>
              <p>Số điện thoại: {ownerDraft.phone.trim()}</p>
              {ownerDraft.email.trim() && <p>Email: {ownerDraft.email.trim()}</p>}
              {ownerDraft.address.trim() && <p className="whitespace-pre-wrap">Địa chỉ: {ownerDraft.address.trim()}</p>}
              <p>Tiếp tục thêm thú cưng sau khi lưu hồ sơ khách.</p>
            </> : <>
            <p className="text-base font-bold">Chủ nuôi: {owner?.fullName}</p>
            <p>Số điện thoại: {owner?.phone || "Chưa có"}</p>
            <p className="break-all">Mã chủ nuôi: {ownerId}</p>
            {addingPet ? <>
              <p className="text-base font-bold">Thú cưng mới: {petDraft.name.trim()}</p>
              <p>{speciesLabels[petDraft.species]} · {genderLabels[petDraft.gender]} · {petDraft.breed || "Chưa rõ giống"}</p>
              <p>Tuổi: {petDraft.ageLabel || "Chưa rõ"} · Cân nặng: {petDraft.weightKg ? `${petDraft.weightKg} kg` : "Chưa rõ"}</p>
              <p>Sức khỏe: {healthLabels[petDraft.healthStatus]} · Dị ứng: {petDraft.allergies || "Chưa ghi nhận"}</p>
              {petDraft.notes && <p className="whitespace-pre-wrap">Ghi chú: {petDraft.notes}</p>}
            </> : <>
              <p className="text-base font-bold">Thú cưng: {pet?.name || "Không còn trong danh sách"} · {pet ? pet.breed || speciesLabels[pet.species] : ""}</p>
              <p className="break-all">Mã thú cưng: {petId}</p>
              {kind === "appointment" ? <><p>Dịch vụ: {service.label}</p><p>Lịch hẹn: {date} · {time}</p></>
                : <><p>{roomLabels[roomType]} · {checkIn} → {checkOut} · {nights} đêm</p>
                  <p>Dịch vụ thêm: {hotelServiceOptions.filter(item => serviceKeys.includes(item.key)).map(item => item.label).join(", ") || "Không"}</p>
                  <p className="font-semibold">Tổng dự kiến: {formatCurrency(total)}</p></>}
              {ownerNote && <p className="whitespace-pre-wrap">Yêu cầu của khách: {ownerNote}</p>}
            </>}
            </>}
          </div>
          <p className="text-sm text-slate-600">{addingOwner ? "Đối chiếu đúng họ tên và thông tin liên hệ của khách trước khi tạo hồ sơ." : "Đối chiếu đúng chủ nuôi, số điện thoại, thú cưng và thông tin dịch vụ trước khi xác nhận."}</p>
          <div className="flex flex-wrap justify-end gap-3">
            {ownerConflict && <Button type="button" variant="outline" disabled={busy} onClick={() => {
              setQuery(phoneKey(ownerDraft.phone)); setAddingOwner(false); setReview(false); setOwnerId(""); setPetId("");
              setOwnerConflict(false); setError(""); setInfo("Chọn đúng hồ sơ khách trong danh sách. Nếu trùng email, tìm lại bằng email của khách.");
            }}>Tìm khách đã có</Button>}
            {uncertainWrite ? <Button type="button" disabled={busy} onClick={async () => {
              setBusy(true); const refreshed = await reload(); setBusy(false); if (refreshed) onClose();
            }}>Tải và kiểm tra danh sách</Button> : <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => { setReview(false); setError(""); setOwnerConflict(false); }}>Quay lại sửa</Button>
              <Button type="button" disabled={busy} onClick={() => void submit()}>{busy ? "Đang lưu..." : `Xác nhận ${addingOwner ? "tạo khách" : addingPet ? "thêm thú cưng" : kind === "appointment" ? "tạo lịch" : "đặt phòng"}`}</Button>
            </>}
          </div>
        </div> : <form onSubmit={reviewInput}>
          {info && <p role="status" className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{info}</p>}
          <fieldset disabled={busy} className="space-y-4">
            {addingOwner ? <>
              <OwnerDraftFields value={ownerDraft} onChange={setOwnerDraft} />
              <Button type="button" variant="outline" onClick={() => { setAddingOwner(false); setError(""); }}>Quay lại chọn khách đã có</Button>
            </> : <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-700">Chọn khách đã có hoặc tạo khách mới</p>
              <Button type="button" variant="outline" icon={<Plus size={16} />} onClick={() => { setAddingOwner(true); setError(""); setInfo(""); }}>Tạo khách mới</Button>
            </div>
            <Input id="reception-owner-search" label="Tìm khách đã có" autoFocus placeholder="Tên, số điện thoại, email hoặc mã chủ nuôi" value={query} onChange={e => setQuery(e.target.value)} />
            <Select id="reception-owner" label="Chủ nuôi" required value={ownerId}
              options={[{ value: "", label: "Chọn hồ sơ khách đã có" }, ...filteredOwners.map(item => ({ value: item.id, label: `${item.fullName} · ${item.phone || item.email || "Chưa có liên hệ"}` }))]}
              onChange={e => { const selected = allOwners.find(item => item.id === e.target.value); if (selected) setAddedOwners(previous => [selected, ...previous.filter(item => item.id !== selected.id)]); setOwnerId(e.target.value); setPetId(""); setInfo(""); setError(""); }} />
            <Pagination {...ownerPage} />
            {!allOwners.length && <p className="text-sm text-slate-600">Chưa có hồ sơ khách. Bấm Tạo khách mới để tiếp nhận khách tại quầy.</p>}
            {owner && <p className="rounded-lg bg-slate-50 p-3 text-sm">{owner.fullName} · {owner.phone || "Chưa có số điện thoại"}{owner.email ? ` · ${owner.email}` : ""}</p>}
            {addingPet ? <>
              <PetDraftFields value={petDraft} onChange={setPetDraft} />
              {kind !== "pet" && <Button type="button" variant="outline" onClick={() => { setAddingPet(false); setError(""); }}>Quay lại chọn thú cưng</Button>}
            </> : <>
              <Select id="reception-pet" label="Thú cưng" required disabled={!owner} value={petId}
                options={[{ value: "", label: "Chọn thú cưng của chủ nuôi" }, ...ownerPets.map(item => ({ value: item.id, label: `${item.name} · ${item.breed || speciesLabels[item.species]} · ${item.id}` }))]}
                onChange={e => { const selected = ownerPets.find(item => item.id === e.target.value); if (selected) setAddedPets(previous => [selected, ...previous.filter(item => item.id !== selected.id)]); setPetId(e.target.value); }} />
              <Pagination {...petPage} />
              {owner && !ownerPets.length && <p className="text-sm text-slate-600">Chủ nuôi chưa có thú cưng. Thêm thú cưng trước khi đặt dịch vụ.</p>}
              <Button type="button" variant="outline" disabled={!owner} icon={<Plus size={16} />} onClick={() => { setAddingPet(true); setError(""); }}>Thêm thú cưng cho chủ nuôi này</Button>
              {kind === "appointment" ? <>
                <Select id="reception-service" label="Dịch vụ" value={type} options={services.map(item => ({ value: item.type, label: item.label }))} onChange={e => setType(e.target.value as AppointmentType)} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input id="reception-date" label="Ngày hẹn" type="date" min={todayVietnam()} required value={date} onChange={e => setDate(e.target.value)} />
                  <Input id="reception-time" label="Giờ hẹn" type="time" required value={time} onChange={e => setTime(e.target.value)} />
                </div>
                <p className="text-sm text-slate-500">Giá tham khảo: {formatCurrency(service.estimatedPrice)}. Phí cuối cùng được chốt trên hóa đơn sau khi sử dụng dịch vụ.</p>
              </> : <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input id="reception-checkin" label="Ngày nhận phòng" type="date" min={todayVietnam()} required value={checkIn} onChange={e => {
                    const value = e.target.value; setCheckIn(value);
                    if (value && checkOut <= value) setCheckOut(nextDay(value));
                  }} />
                  <Input id="reception-checkout" label="Ngày trả phòng" type="date" min={checkIn ? nextDay(checkIn) : todayVietnam()} required value={checkOut} onChange={e => setCheckOut(e.target.value)} />
                </div>
                <Select id="reception-room" label="Loại phòng" value={roomType} onChange={e => setRoomType(e.target.value as HotelRoomType)}
                  options={(Object.keys(roomLabels) as HotelRoomType[]).map(value => ({ value, label: `${roomLabels[value]} · ${formatCurrency(ROOM_PRICES[value])}/đêm` }))} />
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-700">Dịch vụ bổ sung</p>
                  {hotelServiceOptions.map(item => <label key={item.key} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={serviceKeys.includes(item.key)} onChange={e => setServiceKeys(keys => e.target.checked ? [...keys, item.key] : keys.filter(key => key !== item.key))} className="mt-1" />
                    {item.label} · {formatCurrency(item.pricePerNight)}/đêm
                  </label>)}
                </div>
                <p className="rounded-lg bg-slate-50 p-3 font-semibold">{Number.isFinite(nights) && nights > 0 ? `${nights} đêm · Tổng dự kiến: ${formatCurrency(total)}` : "Chọn khoảng lưu trú hợp lệ"}</p>
                <p className="text-sm text-slate-500">Thanh toán cuối kỳ lưu trú. Chưa tạo hóa đơn hoặc VietQR ở bước đặt phòng.</p>
              </>}
              <Textarea id="reception-owner-note" label="Yêu cầu của khách" maxLength={2000} rows={3} value={ownerNote} onChange={e => setOwnerNote(e.target.value)} />
            </>}
            </>}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={onClose}>Hủy</Button>
              <Button type="submit" disabled={!addingOwner && (!owner || (!addingPet && !pet))}>Kiểm tra thông tin</Button>
            </div>
          </fieldset>
        </form>}
      </div>
    </dialog>, document.body,
  );
}
