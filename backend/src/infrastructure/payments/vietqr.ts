import QRCode from "qrcode";
import { QRPay } from "vietnam-qr-pay";
import type { TransferQrGenerator } from "../../application/ports/invoices.js";
import { BusinessError } from "../../domain/error.js";

export class VietQrGenerator implements TransferQrGenerator {
  async generate(details: unknown, amount: number, content: string): Promise<string> {
    const bank = details as Record<string, unknown> | null;
    if (!bank || bank.isDemo !== false || typeof bank.bankBin !== "string" || !/^\d{6}$/.test(bank.bankBin)
      || typeof bank.accountNumber !== "string" || !/^\d{6,19}$/.test(bank.accountNumber))
      throw new BusinessError(409, "Thông tin nhận tiền của hóa đơn chưa hỗ trợ VietQR. Vui lòng dùng thông tin chuyển khoản đã hiển thị.");
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 9_999_999_999 || !/^[A-Z0-9]{1,25}$/.test(content))
      throw new BusinessError(409, "Hóa đơn chưa hỗ trợ VietQR. Vui lòng dùng đúng số tiền và nội dung chuyển khoản đã hiển thị.");
    const payload = QRPay.initVietQR({ bankBin: bank.bankBin, bankNumber: bank.accountNumber,
      amount: String(amount), purpose: content }).build();
    // Generate locally: no account or invoice data is sent to a QR image service.
    return QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 4, width: 320 });
  }
}
