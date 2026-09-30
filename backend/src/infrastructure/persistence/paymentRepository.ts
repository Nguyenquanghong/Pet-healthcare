import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { BusinessError } from "../../domain/error.js";
import type { PaymentRepository, PaymentResult } from "../../application/ports/payments.js";

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly db: PrismaClient) {}
  async latest(invoiceId: string, ownerId?: string) {
    const invoice = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || (ownerId && invoice.ownerId !== ownerId)) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
    const attempt = await this.db.paymentAttempt.findFirst({ where: { invoiceId }, orderBy: { createdAt: "desc" } });
    if (!attempt) throw new BusinessError(409, "Hóa đơn chưa có giao dịch VNPay.");
    return attempt;
  }
  prepare(invoiceId: string, ownerId: string) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice || invoice.ownerId !== ownerId) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
      if (invoice.paymentStatus !== "unpaid") throw new BusinessError(409, "Hóa đơn không còn chờ thanh toán.");
      if (invoice.paymentChannel === "bank_transfer" || invoice.transferReviewStatus === "pending")
        throw new BusinessError(409, "Hóa đơn đang chọn chuyển khoản. Kiểm tra khoản chuyển trước khi dùng cổng thanh toán.");
      if (await tx.paymentAttempt.count({ where: { invoiceId, status: "review" } }))
        throw new BusinessError(409, "Giao dịch cần đối soát với cửa hàng, không thanh toán lại.");
      const pending = await tx.paymentAttempt.findFirst({ where: { invoiceId, status: "pending" } });
      if (pending) {
        if (pending.expiresAt <= new Date()) throw new BusinessError(409, "Giao dịch hết hạn nhưng chưa nhận kết quả VNPay. Vui lòng liên hệ cửa hàng để đối soát, không thanh toán lại.");
        return pending;
      }
      await tx.invoice.update({ where: { id: invoiceId }, data: { paymentChannel: "online" } });
      return tx.paymentAttempt.create({ data: { id: randomUUID().replaceAll("-", ""), invoiceId,
        amount: invoice.totalAmount, expiresAt: new Date(Date.now() + 15 * 60000) } });
    });
  }
  async confirm(result: PaymentResult) {
    try {
      return await this.db.$transaction(async tx => {
        const candidate = await tx.paymentAttempt.findUnique({ where: { id: result.reference } });
        if (!candidate) return { RspCode: "01", Message: "Order not found" };
        // All invoice mutations use the same lock order, including onsite confirmation.
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${candidate.invoiceId} FOR UPDATE`;
        const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: result.reference } });
        const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: attempt.invoiceId } });
        if (Number(attempt.amount) !== result.amount || Number(invoice.totalAmount) !== result.amount)
          return { RspCode: "04", Message: "Invalid amount" };
        if (["succeeded", "review"].includes(attempt.status) || (attempt.status === "failed" && !result.success))
          return { RspCode: "02", Message: "Order already confirmed" };
        if (!result.success) {
          await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "failed", responseCode: result.responseCode } });
          return { RspCode: "00", Message: "Confirm Success" };
        }
        const conflict = invoice.paymentStatus !== "unpaid" || attempt.status === "failed";
        await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: conflict ? "review" : "succeeded", transactionNo: result.transactionNo, responseCode: result.responseCode } });
        if (conflict) {
          await tx.notification.create({ data: { recipientRole: "admin", type: "payment_review", title: "Cần đối soát VNPay",
            message: `Giao dịch ${attempt.id} thành công nhưng hóa đơn ${invoice.invoiceCode} đã có trạng thái khác.`, actionUrl: "/admin/billing" } });
        } else {
          await tx.invoice.update({ where: { id: invoice.id }, data: { paymentStatus: "paid", paymentChannel: "online", paymentMethod: "vnpay", paidAt: new Date() } });
          await tx.notification.create({ data: { recipientOwnerId: invoice.ownerId, recipientRole: "owner", type: "invoice_paid",
            title: "Thanh toán VNPay thành công", message: `Đã nhận thanh toán cho hóa đơn ${invoice.invoiceCode}.`, actionUrl: "/owner/billing" } });
        }
        return { RspCode: "00", Message: "Confirm Success" };
      });
    } catch { return { RspCode: "99", Message: "Unable to confirm; retry" }; }
  }
}
