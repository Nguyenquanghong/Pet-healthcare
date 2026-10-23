import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import { authorize } from "../../domain/authorization.js";
import type { BookingKind, BookingLifecycleStore, LifecycleTransaction, BookingPatch } from "../ports/bookingLifecycle.js";

export type LifecycleInput = { status?: unknown; expectedRevision?: unknown; internalNote?: string | null };
export type UndoInput = { expectedRevision?: unknown; reason?: unknown };
const transitions: Record<string,string[]>={pending:['confirmed','cancelled'],confirmed:['checked_in','no_show','cancelled'],checked_in:['in_progress'],in_progress:['completed']};
const statusLabels: Record<string, string> = { pending: "chờ xác nhận", confirmed: "đã xác nhận", checked_in: "đã nhận thú cưng",
  in_progress: "đang thực hiện", completed: "hoàn thành dịch vụ", in_stay: "đang lưu trú", checked_out: "đã trả thú cưng",
  cancelled: "đã hủy", rejected: "đã từ chối", no_show: "vắng mặt" };
function staff(actor: Actor) { authorize(actor, "booking.manage"); }
function revision(tx: LifecycleTransaction, value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BusinessError(422, "Thiếu phiên bản lịch đặt. Hãy tải lại trang.");
  if (value !== tx.booking.statusRevision) throw new BusinessError(409, "Lịch đặt vừa được cập nhật. Hãy tải lại và kiểm tra trước khi thao tác.");
}
function note(value: unknown) {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 2000))
    throw new BusinessError(422, "Ghi chú tối đa 2.000 ký tự.");
}
function dependentDataMessage(linked: { medical: number; invoices: number }, action: string) {
  const kinds = [linked.medical && "bệnh án", linked.invoices && "hóa đơn"].filter(Boolean).join(", ");
  return `Lịch đã liên kết ${kinds}; không thể ${action} trực tiếp. Hãy đối chiếu dữ liệu liên quan trước khi xử lý. Chưa có chức năng ghi đè trạng thái.`;
}
export class BookingLifecycleService {
  constructor(private readonly store: BookingLifecycleStore) {}
  history(actor: Actor, kind: BookingKind, id: string) { staff(actor); return this.store.history(kind, id); }
  change(actor: Actor, kind: BookingKind, id: string, input: LifecycleInput) {
    staff(actor); note(input.internalNote);
    return this.store.run(kind, id, async tx => {
      revision(tx, input.expectedRevision);
      const from = String(tx.booking.status), to = String(input.status || "");
      if (from === to) {
        if (input.internalNote === undefined || input.internalNote === tx.booking.internalNote) return tx.booking;
        const saved = await tx.save(from, { internalNote: input.internalNote });
        await tx.event(actor, "note_updated", from, from, saved.statusRevision);
        return saved;
      }
      if (!transitions[from]?.includes(to)) throw new BusinessError(409, "Không thể chuyển trạng thái theo thứ tự này. Nếu thao tác nhầm, hãy dùng Hoàn tác.");
      const linked = await tx.dependencies();
      if (linked.invoices || linked.medical)
        throw new BusinessError(409, dependentDataMessage(linked, "đổi trạng thái"));
      const saved = await tx.save(to, { internalNote: input.internalNote });
      await tx.event(actor, "transition", from, to, saved.statusRevision);
      await tx.notify(`Trạng thái lịch đặt: ${statusLabels[from]} → ${statusLabels[to]}.`);
      return saved;
    });
  }
  undo(actor: Actor, kind: BookingKind, id: string, input: UndoInput) {
    staff(actor);
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
      throw new BusinessError(422, "Nhập lý do hoàn tác (tối đa 500 ký tự).");
    const reason = input.reason.trim();
    return this.store.run(kind, id, async tx => {
      revision(tx, input.expectedRevision);
      const from = String(tx.booking.status);
      const checkin = from === "checked_in";
      const finished = from === "completed";
      if (!checkin && !finished) throw new BusinessError(409, "Chỉ hoàn tác check-in khi chưa bắt đầu dịch vụ, hoặc mở lại dịch vụ vừa hoàn thành.");
      if (finished) authorize(actor, "booking.reopen");
      const linked = await tx.dependencies();
      if (linked.medical || linked.invoices)
        throw new BusinessError(409, dependentDataMessage(linked, "hoàn tác"));
      const event = await tx.latestTransition();
      if (!event || event.action !== "transition" || event.toStatus !== from)
        throw new BusinessError(409, "Không có thao tác gốc phù hợp để hoàn tác. Lịch cũ cần quản trị viên kiểm tra riêng.");
      const target = checkin ? "confirmed" : "in_progress";
      if (event.fromStatus !== target) throw new BusinessError(409, "Thao tác gốc không khớp trạng thái cần khôi phục.");
      const saved = await tx.save(target);
      await tx.event(actor, "undo", from, target, saved.statusRevision, reason, event.id);
      await tx.notify("Cửa hàng đã điều chỉnh thao tác nhầm trên lịch đặt. Lịch vẫn còn hiệu lực; vui lòng xem trạng thái mới hoặc liên hệ cửa hàng.");
      return saved;
    });
  }
  cancel(actor: Actor, kind: BookingKind, id: string, expectedRevision: unknown, ownerNote?: string) {
    note(ownerNote);
    return this.store.run(kind, id, async tx => {
      if (actor.role === "owner" && tx.booking.ownerId !== actor.sub) throw new BusinessError(403, "Bạn không sở hữu lịch đặt này.");
      revision(tx, expectedRevision);
      if (!["pending", "confirmed"].includes(tx.booking.status)) throw new BusinessError(409, "Chỉ hủy lịch chưa nhận thú cưng.");
      const linked = await tx.dependencies();
      if (linked.medical || linked.invoices) throw new BusinessError(409, dependentDataMessage(linked, "hủy lịch"));
      const saved = await tx.save("cancelled", ownerNote ? { ownerNote } : undefined);
      await tx.event(actor, "cancelled", tx.booking.status, "cancelled", saved.statusRevision, ownerNote);
      await tx.notify("Lịch đặt đã được hủy.");
      return saved;
    });
  }
  reschedule(actor: Actor, id: string, expectedRevision: unknown, patch: BookingPatch) {
    return this.store.run("appointment", id, async tx => {
      if (actor.role === "owner" && tx.booking.ownerId !== actor.sub) throw new BusinessError(403, "Bạn không sở hữu lịch đặt này.");
      revision(tx, expectedRevision);
      if (!["pending", "confirmed"].includes(tx.booking.status)) throw new BusinessError(409, "Chỉ đổi lịch chưa nhận thú cưng.");
      const linked = await tx.dependencies();
      if (linked.medical || linked.invoices) throw new BusinessError(409, dependentDataMessage(linked, "đổi lịch"));
      const saved = await tx.save("pending", patch);
      await tx.event(actor, "rescheduled", tx.booking.status, "pending", saved.statusRevision);
      await tx.notify("Lịch hẹn đã đổi thời gian và đang chờ xác nhận lại.", "admin");
      return saved;
    });
  }
}
