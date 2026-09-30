import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { InvoiceRepository, InvoiceLine, BankTransferDetails, TransferQrGenerator } from "../ports/invoices.js";
import pricing from "../../domain/pricing.json" with { type: "json" };

function money(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999)
    throw new BusinessError(422, `${name} phải là số tiền VND nguyên, không âm và không quá 9.999.999.999.`);
  return value;
}
function lines(value: unknown): InvoiceLine[] {
  if (!Array.isArray(value) || value.length > 50) throw new BusinessError(422, "Tối đa 50 dòng dịch vụ.");
  return value.map(raw => {
    if (!raw || typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 300)
      throw new BusinessError(422, "Mỗi dòng cần mô tả dịch vụ (tối đa 300 ký tự).");
    if (!Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > 10000)
      throw new BusinessError(422, "Số lượng phải từ 1 đến 10.000.");
    const unitPrice = money(raw.unitPrice, "Đơn giá");
    return { description: raw.description.trim(), unitPrice, quantity: raw.quantity, amount: money(unitPrice * raw.quantity, "Thành tiền") };
  });
}
export class InvoicesService {
  constructor(private readonly invoices: InvoiceRepository, private readonly bankTransfer: BankTransferDetails | null = null,
    private readonly qr?: TransferQrGenerator) {}
  list(actor: Actor, requestedOwnerId?: string) {
    return this.invoices.list(actor.role === "owner" ? actor.sub : requestedOwnerId);
  }
  create(actor: Actor, input: Record<string, unknown>) {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    return this.issue(actor, input, false);
  }
  checkout(actor: Actor, input: Record<string, unknown>) {
    if (actor.role !== "owner") throw new BusinessError(403, "Chỉ chủ nuôi được tự tạo yêu cầu thanh toán.");
    if (input.type === "hotel_booking") throw new BusinessError(403, "Hóa đơn lưu trú cần nhân viên chốt phí cuối kỳ.");
    if (Object.keys(input).some(key => !["type", "relatedId"].includes(key)))
      throw new BusinessError(422, "Giá được tính ở hệ thống, không nhận số tiền từ khách hàng.");
    return this.issue(actor, input, true);
  }
  private issue(actor: Actor, input: Record<string, unknown>, selfCheckout: boolean) {
    if ((input.type !== "appointment" && input.type !== "hotel_booking") || typeof input.relatedId !== "string" || !input.relatedId.trim())
      throw new BusinessError(422, "Chọn lịch khám hoặc lượt lưu trú cần lập hóa đơn.");
    const type = input.type, relatedId = input.relatedId;
    const taxAmount = money(input.taxAmount ?? 0, "Tiền thuế"), discountAmount = money(input.discountAmount ?? 0, "Giảm giá");
    // Keep the older single-subtotal API compatible; new UI sends itemized charges.
    const legacySubtotal = type === "appointment" && input.items === undefined && !selfCheckout ? money(input.subtotal, "Tiền dịch vụ") : undefined;
    if (type === "hotel_booking" && input.subtotal !== undefined) throw new BusinessError(422, "Tiền lưu trú được lấy từ booking đã lưu.");
    const extra = input.items === undefined ? [] : lines(input.items);
    if (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 2000))
      throw new BusinessError(422, "Ghi chú không được dài quá 2.000 ký tự.");
    return this.invoices.issue(async tx => {
      const source = await tx.source(type, relatedId);
      if (!source || (selfCheckout && source.ownerId !== actor.sub)) throw new BusinessError(404, "Không tìm thấy dịch vụ.");
      if (source.status !== (type === "appointment" ? "completed" : "in_stay") &&
          !(type === "hotel_booking" && source.status === "checked_out"))
        throw new BusinessError(409, "Chỉ chốt phí sau khi khám hoàn tất hoặc trong kỳ lưu trú.");
      if (selfCheckout) {
        const existing = await tx.findSource(type, relatedId);
        if (existing) return existing;
      }
      const fixedSpa = pricing.fixedSpaRates[source.serviceType as keyof typeof pricing.fixedSpaRates];
      let items: InvoiceLine[];
      if (type === "hotel_booking") {
        const base = money(source.amount, "Tiền lưu trú");
        items = [{ description: source.description, quantity: 1, unitPrice: base, amount: base }, ...extra];
      } else if (selfCheckout) {
        if (!fixedSpa) throw new BusinessError(409, "Dịch vụ này cần nhân viên chốt phí trước.");
        items = [{ description: source.description, quantity: 1, unitPrice: fixedSpa, amount: fixedSpa }];
      } else {
        items = input.items === undefined ? [{ description: source.description, quantity: 1, unitPrice: legacySubtotal!, amount: legacySubtotal! }] : extra;
      }
      if (!items.length) throw new BusinessError(422, "Hóa đơn cần ít nhất một dòng dịch vụ.");
      const subtotal = money(items.reduce((sum, item) => sum + item.amount, 0), "Tạm tính");
      if (discountAmount > subtotal) throw new BusinessError(422, "Giảm giá không được vượt quá tiền dịch vụ.");
      const totalAmount = money(subtotal + taxAmount - discountAmount, "Tổng tiền");
      if (totalAmount <= 0) throw new BusinessError(422, "Tổng tiền phải lớn hơn 0.");
      const invoice = await tx.create({ type, ownerId: source.ownerId, petId: source.petId,
        appointmentId: type === "appointment" ? relatedId : null, hotelBookingId: type === "hotel_booking" ? relatedId : null,
        subtotal, taxAmount, discountAmount, totalAmount, items, notes: typeof input.notes === "string" ? input.notes.trim() || null : null });
      await tx.notify({ recipientOwnerId: source.ownerId, recipientRole: "owner", type: "invoice_requested",
        title: "Yêu cầu thanh toán", message: `Hóa đơn ${invoice.invoiceCode}: ${totalAmount.toLocaleString("vi-VN")} VND. Vui lòng kiểm tra các khoản phí.`, actionUrl: "/owner/billing" });
      return invoice;
    });
  }
  chooseOnsite(actor: Actor, id: string) {
    if (actor.role !== "owner") throw new BusinessError(403, "Chỉ chủ nuôi được chọn cách thanh toán.");
    return this.invoices.chooseOnsite(id, actor.sub);
  }
  chooseTransfer(actor: Actor, id: string) {
    if (actor.role !== "owner") throw new BusinessError(403, "Chỉ chủ nuôi được chọn cách thanh toán.");
    if (!this.bankTransfer) throw new BusinessError(409, "Cửa hàng chưa cấu hình tài khoản nhận chuyển khoản.");
    return this.invoices.chooseTransfer(id, actor.sub, this.bankTransfer);
  }
  async transferQr(actor: Actor, id: string) {
    const invoice = await this.invoices.find(id, actor.role === "owner" ? actor.sub : undefined);
    if (!invoice) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
    if (invoice.paymentStatus !== "unpaid" || invoice.paymentChannel !== "bank_transfer" || invoice.transferReviewStatus === "pending")
      throw new BusinessError(409, "Hóa đơn đã thanh toán hoặc đang chờ kiểm tra chuyển khoản; không tạo QR để thu thêm.");
    if (!this.qr) throw new BusinessError(409, "Chưa cấu hình bộ tạo QR.");
    const content = invoice.transferCode || invoice.invoiceCode.replaceAll("-", "");
    const dataUrl = await this.qr.generate(invoice.bankTransferDetails, Number(invoice.totalAmount), content);
    return { dataUrl, content, amount: Number(invoice.totalAmount) };
  }
  reportTransfer(actor: Actor, id: string, reference: unknown) {
    if (actor.role !== "owner") throw new BusinessError(403, "Chỉ chủ nuôi được báo đã chuyển khoản.");
    if (reference !== undefined && (typeof reference !== "string" || reference.length > 100))
      throw new BusinessError(422, "Mã giao dịch tối đa 100 ký tự.");
    return this.invoices.reportTransfer(id, actor.sub, typeof reference === "string" ? reference.trim() || null : null, actor);
  }
  rejectTransfer(actor: Actor, id: string, reason: unknown) {
    if (actor.role === "owner") throw new BusinessError(403, "Chỉ nhân viên được kiểm tra chuyển khoản.");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
      throw new BusinessError(422, "Nhập lý do chưa xác nhận (tối đa 500 ký tự).");
    return this.invoices.rejectTransfer(id, reason.trim(), actor);
  }
  pay(actor: Actor, id: string, paymentMethod: unknown = "cash") {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    if (typeof paymentMethod !== "string" || !["cash", "bank_transfer"].includes(paymentMethod))
      throw new BusinessError(422, "Phương thức thanh toán không hợp lệ.");
    return this.invoices.pay(id, paymentMethod, new Date(), actor);
  }
  async paymentHistory(actor: Actor, id: string) {
    if (actor.role === "owner") throw new BusinessError(403, "Chỉ nhân viên được xem lịch sử kiểm tra thu tiền.");
    const invoice = await this.invoices.find(id);
    if (!invoice) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
    return this.invoices.paymentHistory(id);
  }
}
