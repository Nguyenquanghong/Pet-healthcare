import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { InvoiceRepository, InvoiceIssuance, BankTransferDetails } from "../../application/ports/invoices.js";
import { BusinessError } from "../../domain/error.js";
import type { Actor } from "../../domain/auth.js";

async function recordPaymentEvent(tx: Prisma.TransactionClient, invoiceId: string, action: string,
  fromStatus: string, toStatus: string, actor: Actor, reason?: string | null, reference?: string | null) {
  const user = await tx.user.findUnique({ where: { id: actor.sub }, select: { fullName: true } });
  await tx.paymentEvent.create({ data: { invoiceId, action, fromStatus, toStatus, actorId: actor.sub,
    actorName: user?.fullName ?? actor.sub, actorRole: actor.role, reason, reference } });
}

export class PrismaInvoiceRepository implements InvoiceRepository {
  constructor(private readonly client: PrismaClient) {}
  list(ownerId?: string) {
    return this.client.invoice.findMany({ where: ownerId ? { ownerId } : undefined, include: { items: true }, orderBy: { issuedAt: "desc" } });
  }
  find(id: string, ownerId?: string) {
    return this.client.invoice.findFirst({ where: { id, ...(ownerId ? { ownerId } : {}) }, include: { items: true } });
  }
  pay(id: string, paymentMethod: string, paidAt: Date, actor: Actor) {
    return this.client.$transaction(async (tx) => {
      // Conditional write serializes competing payments; a retry cannot overwrite the receipt.
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
      const before = await tx.invoice.findUnique({ where: { id } });
      if (before?.paymentChannel === "online") throw new BusinessError(409, "Hóa đơn VNPay chỉ được xác nhận từ kết quả của cổng thanh toán.");
      if (before?.paymentChannel === "bank_transfer" && paymentMethod !== "bank_transfer")
        throw new BusinessError(409, "Hóa đơn chuyển khoản cần được xác nhận đúng phương thức chuyển khoản.");
      if (await tx.paymentAttempt.count({ where: { invoiceId: id, status: { in: ["pending", "review"] } } }))
        throw new BusinessError(409, "Giao dịch VNPay cần đối soát, không xác nhận thu tiền lần nữa.");
      const changed = await tx.invoice.updateMany({ where: { id, paymentStatus: "unpaid" },
        data: { paymentStatus: "paid", paymentMethod: paymentMethod as "cash" | "bank_transfer", paidAt,
          paymentChannel: before?.paymentChannel === "bank_transfer" ? "bank_transfer" : "onsite",
          ...(before?.paymentChannel === "bank_transfer" ? { transferReviewStatus: "confirmed", transferReviewNote: null } : {}) } });
      const invoice = await tx.invoice.findUnique({ where: { id }, include: { items: true } });
      if (!invoice) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
      if (invoice.paymentStatus !== "paid" || invoice.paymentMethod !== paymentMethod) {
        throw new BusinessError(409, "Hóa đơn đã được thanh toán bằng phương thức khác hoặc đã hoàn tiền.");
      }
      if (changed.count) {
        await recordPaymentEvent(tx, id, "payment_confirmed", before!.paymentStatus, "paid", actor,
          null, before?.paymentChannel === "bank_transfer" ? before.transferReference : null);
        await tx.notification.create({ data: { recipientOwnerId: invoice.ownerId, recipientRole: "owner", type: "invoice_paid",
          title: "Đã xác nhận thanh toán", message: `Hóa đơn ${invoice.invoiceCode} đã được xác nhận thu đủ tiền.`, actionUrl: "/owner/billing" } });
      }
      return invoice;
    });
  }
  async issue<T>(work: (transaction: InvoiceIssuance) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(async (tx) => work({
        source: async (type, id) => {
          if (type === "appointment") {
            await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
            const item = await tx.appointment.findUnique({ where: { id } });
            return item ? { ownerId: item.ownerId, petId: item.petId, status: item.status, description: item.serviceName, serviceType: item.type } : null;
          }
          await tx.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${id} FOR UPDATE`;
          const item = await tx.hotelBooking.findUnique({ where: { id } });
          return item ? { ownerId: item.ownerId, petId: item.petId, status: item.status,
            description: `Lưu trú ${item.roomType}, ${item.nights} đêm (gồm dịch vụ đã đặt)`, amount: Number(item.totalAmount) } : null;
        },
        findSource: (type, id) => tx.invoice.findFirst({ where: type === "appointment" ? { appointmentId: id } : { hotelBookingId: id }, include: { items: true } }),
        notify: async data => { await tx.notification.create({ data }); },
        create: ({ items, ...data }) => tx.invoice.create({ data: { ...data,
          invoiceCode: `INV-${randomUUID()}`, paymentStatus: "unpaid",
          items: { create: items },
        }, include: { items: true } }),
      }));
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new BusinessError(409, "Dịch vụ này đã có hóa đơn. Hãy tải lại danh sách.");
      throw error;
    }
  }
  chooseOnsite(id: string, ownerId: string) {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({ where: { id }, include: { items: true } });
      if (!invoice || invoice.ownerId !== ownerId) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
      if (invoice.paymentStatus !== "unpaid") throw new BusinessError(409, "Hóa đơn không còn chờ thanh toán.");
      if (invoice.transferReviewStatus === "pending")
        throw new BusinessError(409, "Bạn đã báo chuyển khoản. Hãy chờ cửa hàng kiểm tra trước khi đổi cách thanh toán.");
      if (await tx.paymentAttempt.count({ where: { invoiceId: id, status: { in: ["pending", "review"] } } }))
        throw new BusinessError(409, "Có giao dịch VNPay chưa được đối soát. Vui lòng chờ kết quả hoặc liên hệ cửa hàng.");
      return tx.invoice.update({ where: { id }, data: { paymentChannel: "onsite" }, include: { items: true } });
    });
  }
  chooseTransfer(id: string, ownerId: string, details: BankTransferDetails) {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({ where: { id }, include: { items: true } });
      if (!invoice || invoice.ownerId !== ownerId) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
      if (invoice.paymentStatus !== "unpaid") throw new BusinessError(409, "Hóa đơn không còn chờ thanh toán.");
      if (await tx.paymentAttempt.count({ where: { invoiceId: id, status: { in: ["pending", "review"] } } }))
        throw new BusinessError(409, "Có giao dịch cổng thanh toán cần đối soát. Không chuyển khoản thêm.");
      if (invoice.paymentChannel === "bank_transfer") return invoice;
      return tx.invoice.update({ where: { id }, data: { paymentChannel: "bank_transfer",
        // Keep the destination already presented to the customer if configuration changes later.
        ...(invoice.bankTransferDetails ? {} : { bankTransferDetails: details }) }, include: { items: true } });
    });
  }
  reportTransfer(id: string, ownerId: string, reference: string | null, actor: Actor) {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({ where: { id }, include: { items: true } });
      if (!invoice || invoice.ownerId !== ownerId) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
      if (invoice.paymentStatus !== "unpaid" || invoice.paymentChannel !== "bank_transfer")
        throw new BusinessError(409, "Hãy chọn chuyển khoản trên hóa đơn còn chờ thanh toán.");
      if (invoice.transferReviewStatus === "pending") return invoice;
      const updated = await tx.invoice.update({ where: { id }, data: { transferReviewStatus: "pending",
        transferReportedAt: new Date(), transferReference: reference, transferReviewNote: null }, include: { items: true } });
      await recordPaymentEvent(tx, id, "transfer_reported", invoice.transferReviewStatus ?? "none", "pending", actor, null, reference);
      await tx.notification.create({ data: { recipientRole: "admin", type: "transfer_reported",
        title: "Khách báo đã chuyển khoản", message: `Kiểm tra tiền nhận cho hóa đơn ${invoice.invoiceCode} trước khi xác nhận.`,
        actionUrl: "/admin/billing" } });
      return updated;
    });
  }
  rejectTransfer(id: string, reason: string, actor: Actor) {
    return this.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw new BusinessError(404, "Không tìm thấy hóa đơn.");
      if (invoice.paymentStatus !== "unpaid" || invoice.paymentChannel !== "bank_transfer" || invoice.transferReviewStatus !== "pending")
        throw new BusinessError(409, "Báo chuyển khoản không còn chờ kiểm tra. Hãy tải lại.");
      const updated = await tx.invoice.update({ where: { id }, data: { transferReviewStatus: "rejected", transferReviewNote: reason }, include: { items: true } });
      await recordPaymentEvent(tx, id, "transfer_rejected", "pending", "rejected", actor, reason, invoice.transferReference);
      await tx.notification.create({ data: { recipientOwnerId: invoice.ownerId, recipientRole: "owner", type: "transfer_rejected",
        title: "Chuyển khoản cần kiểm tra lại", message: `Hóa đơn ${invoice.invoiceCode}: ${reason}`, actionUrl: "/owner/billing" } });
      return updated;
    });
  }
  paymentHistory(id: string) {
    return this.client.paymentEvent.findMany({ where: { invoiceId: id }, orderBy: { createdAt: "desc" } });
  }
}
