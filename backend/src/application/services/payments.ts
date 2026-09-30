import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { PaymentGateway, PaymentRepository, IpnReply } from "../ports/payments.js";
import type { BankTransferDetails } from "../ports/invoices.js";

export class PaymentsService {
  constructor(private readonly repository: PaymentRepository, private readonly gateway: PaymentGateway, private readonly bankTransfer: BankTransferDetails | null = null) {}
  options() { return { vnpayEnabled: this.gateway.enabled(), environment: "sandbox", bankTransfer: this.bankTransfer }; }
  async start(actor: Actor, invoiceId: string, ip: string) {
    if (actor.role !== "owner") throw new BusinessError(403, "Chỉ chủ nuôi được thanh toán hóa đơn của mình.");
    if (!this.gateway.enabled()) throw new BusinessError(409, "VNPay Sandbox chưa được cấu hình. Bạn có thể chọn thanh toán tại cửa hàng.");
    const attempt = await this.repository.prepare(invoiceId, actor.sub);
    return { paymentUrl: this.gateway.url(attempt, ip), reference: attempt.id };
  }
  verifyReturn(query: Record<string, unknown>) {
    // The browser return is informational only; it never changes payment state.
    return { verified: this.gateway.verify(query) !== null };
  }
  async reconcile(actor: Actor, invoiceId: string, ip: string) {
    if (!this.gateway.enabled()) throw new BusinessError(409, "VNPay Sandbox chưa được cấu hình.");
    const attempt = await this.repository.latest(invoiceId, actor.role === "owner" ? actor.sub : undefined);
    if (attempt.status === "review") throw new BusinessError(409, "Giao dịch cần cửa hàng đối soát với VNPay; không thu tiền lần nữa.");
    const result = await this.gateway.query(attempt, ip);
    if (!result) return { message: "VNPay chưa có kết quả cuối cùng. Vui lòng thử kiểm tra lại sau." };
    const reply = await this.repository.confirm(result);
    if (!["00", "02"].includes(reply.RspCode)) throw new BusinessError(409, "Kết quả đối soát chưa khớp hóa đơn. Vui lòng liên hệ cửa hàng.");
    return { message: result.success ? "Đã nhận kết quả VNPay. Hãy kiểm tra trạng thái hóa đơn." : "VNPay xác nhận giao dịch thất bại. Bạn có thể chọn lại phương thức thanh toán." };
  }
  async ipn(query: Record<string, unknown>): Promise<IpnReply> {
    const result = this.gateway.verify(query);
    if (!result) return { RspCode: "97", Message: "Invalid signature or merchant" };
    return this.repository.confirm(result);
  }
}
