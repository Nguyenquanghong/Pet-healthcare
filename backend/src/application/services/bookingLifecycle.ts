import { cancelRule, manualTransition, rescheduleRule, statusLabel, undoRule, type LifecycleGuard } from "@nipopeto/contracts";
import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import { authorize } from "../../domain/authorization.js";
import type { BookingKind, BookingLifecycleStore, LifecycleTransaction, BookingPatch } from "../ports/bookingLifecycle.js";

export type LifecycleInput = { status?: unknown; expectedRevision?: unknown; internalNote?: string | null };
export type UndoInput = { expectedRevision?: unknown; reason?: unknown };
// P01: the rules come from the lifecycle table in @nipopeto/contracts; this
// service checks every guard the table can name.
function staff(actor: Actor) { authorize(actor, "booking.manage"); }
function revision(tx: LifecycleTransaction, value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BusinessError(422, "Thiếu phiên bản lịch đặt. Hãy tải lại trang.");
  if (value !== tx.booking.statusRevision) throw new BusinessError(409, "Lịch đặt vừa được cập nhật. Hãy tải lại và kiểm tra trước khi thao tác.");
}
function note(value: unknown) {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 2000))
    throw new BusinessError(422, "Ghi chú tối đa 2.000 ký tự.");
}
function dependentDataMessage(linked: { medical: number; care: number; invoices: number }, action: string) {
  const kinds = [linked.medical && "bệnh án", linked.care && "nhật ký chăm sóc", linked.invoices && "hóa đơn"].filter(Boolean).join(", ");
  return `Lịch đã liên kết ${kinds}; không thể ${action} trực tiếp. Hãy đối chiếu dữ liệu liên quan trước khi xử lý. Chưa có chức năng ghi đè trạng thái.`;
}
// Strategy per guard name over the data linked to the booking.
async function guard(tx: LifecycleTransaction, guards: readonly LifecycleGuard[], action: string) {
  const linked = await tx.dependencies();
  if (guards.includes("final-invoice-paid") && await tx.hotelInvoiceStatus() !== "paid")
    throw new BusinessError(409, "Chỉ trả thú cưng khi hóa đơn cuối cùng đã được xác nhận thu đủ tiền.");
  if ((guards.includes("no-medical-record") && linked.medical) || (guards.includes("no-active-invoice") && linked.invoices) || (guards.includes("no-care-note") && linked.care))
    throw new BusinessError(409, dependentDataMessage(linked, action));
}
export class BookingLifecycleService {
  constructor(private readonly store: BookingLifecycleStore) {}
  history(actor: Actor, kind: BookingKind, id: string) { staff(actor); return this.store.history(kind, id); }
  change(actor: Actor, kind: BookingKind, id: string, input: LifecycleInput) {
    staff(actor); note(input.internalNote);
    return this.store.run(kind, id, async tx => {
      revision(tx, input.expectedRevision);
      const from = tx.booking.status, to = String(input.status || "");
      if (from === to) {
        if (input.internalNote === undefined || input.internalNote === tx.booking.internalNote) return tx.booking;
        const saved = await tx.save(from, { internalNote: input.internalNote });
        await tx.event(actor, "note_updated", from, from, saved.statusRevision);
        return saved;
      }
      const rule = manualTransition(kind, from, to);
      if (!rule) throw new BusinessError(409, "Không thể chuyển trạng thái theo thứ tự này. Nếu thao tác nhầm, hãy dùng Hoàn tác.");
      authorize(actor, rule.permission);
      await guard(tx, rule.guards, "đổi trạng thái");
      const saved = await tx.save(to, { internalNote: input.internalNote });
      await tx.event(actor, "transition", from, to, saved.statusRevision);
      await tx.notify(`Trạng thái lịch đặt: ${statusLabel(from)} → ${statusLabel(to)}.`);
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
      const from = tx.booking.status;
      const rule = undoRule(kind, from);
      if (!rule) throw new BusinessError(409, "Chỉ hoàn tác check-in khi chưa bắt đầu dịch vụ, hoặc mở lại dịch vụ vừa hoàn thành.");
      authorize(actor, rule.permission);
      await guard(tx, rule.guards, "hoàn tác");
      const event = await tx.latestTransition();
      if (!event || event.action !== "transition" || event.toStatus !== from)
        throw new BusinessError(409, "Không có thao tác gốc phù hợp để hoàn tác. Lịch cũ cần quản trị viên kiểm tra riêng.");
      const target = rule.to;
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
      const rule = cancelRule(kind);
      if (!rule.from.includes(tx.booking.status)) throw new BusinessError(409, "Chỉ hủy lịch chưa nhận thú cưng.");
      await guard(tx, rule.guards, "hủy lịch");
      const saved = await tx.save(rule.to, ownerNote ? { ownerNote } : undefined);
      await tx.event(actor, "cancelled", tx.booking.status, rule.to, saved.statusRevision, ownerNote);
      await tx.notify("Lịch đặt đã được hủy.");
      return saved;
    });
  }
  reschedule(actor: Actor, id: string, expectedRevision: unknown, patch: BookingPatch) {
    return this.store.run("appointment", id, async tx => {
      if (actor.role === "owner" && tx.booking.ownerId !== actor.sub) throw new BusinessError(403, "Bạn không sở hữu lịch đặt này.");
      revision(tx, expectedRevision);
      const rule = rescheduleRule("appointment")!;
      if (!rule.from.includes(tx.booking.status)) throw new BusinessError(409, "Chỉ đổi lịch chưa nhận thú cưng.");
      await guard(tx, rule.guards, "đổi lịch");
      const saved = await tx.save(rule.to, patch);
      await tx.event(actor, "rescheduled", tx.booking.status, rule.to, saved.statusRevision);
      await tx.notify("Lịch hẹn đã đổi thời gian và đang chờ xác nhận lại.", "admin");
      return saved;
    });
  }
}
