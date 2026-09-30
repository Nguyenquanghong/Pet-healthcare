import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { BusinessError } from "../../domain/error.js";
import type { PaymentAttemptValue, PaymentGateway } from "../../application/ports/payments.js";

export function canonicalVnpay(params: Record<string, string>): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join("&");
}
export function signVnpay(params: Record<string, string>, secret: string) {
  return createHmac("sha512", secret).update(canonicalVnpay(params), "utf8").digest("hex");
}
function vnDate(date: Date) { return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 19).replace(/[-T:]/g, ""); }
export class VnpaySandboxGateway implements PaymentGateway {
  constructor(private readonly config: { tmnCode: string; hashSecret: string; returnUrl: string; active?: boolean }) {}
  enabled() {
    if (this.config.active === false) return false;
    try {
      const url = new URL(this.config.returnUrl);
      return /^[A-Z0-9]{8}$/i.test(this.config.tmnCode) && this.config.hashSecret.length >= 16 &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
    } catch { return false; }
  }
  url(attempt: PaymentAttemptValue, ip: string) {
    const params = { vnp_Version: "2.1.0", vnp_Command: "pay", vnp_TmnCode: this.config.tmnCode,
      vnp_Amount: String(Number(attempt.amount) * 100), vnp_CurrCode: "VND", vnp_TxnRef: attempt.id,
      vnp_OrderInfo: `Thanh toan hoa don ${attempt.id}`, vnp_OrderType: "other", vnp_Locale: "vn",
      vnp_IpAddr: ip.replace(/^::ffff:/, ""), vnp_CreateDate: vnDate(attempt.createdAt),
      vnp_ExpireDate: vnDate(attempt.expiresAt), vnp_ReturnUrl: this.config.returnUrl };
    return `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?${canonicalVnpay(params)}&vnp_SecureHash=${signVnpay(params, this.config.hashSecret)}`;
  }
  async query(attempt: PaymentAttemptValue, ip: string) {
    const request = { vnp_RequestId: randomUUID().replaceAll("-", ""), vnp_Version: "2.1.0", vnp_Command: "querydr",
      vnp_TmnCode: this.config.tmnCode, vnp_TxnRef: attempt.id, vnp_TransactionDate: vnDate(attempt.createdAt),
      vnp_CreateDate: vnDate(new Date()), vnp_IpAddr: ip.replace(/^::ffff:/, ""), vnp_OrderInfo: `Kiem tra ${attempt.id}` };
    const hash = (value: string) => createHmac("sha512", this.config.hashSecret).update(value, "utf8").digest("hex");
    let data: Record<string, unknown>;
    try {
      const response = await fetch("https://sandbox.vnpayment.vn/merchant_webapi/api/transaction", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ ...request, vnp_SecureHash: hash(Object.values(request).join("|")) }),
      });
      if (!response.ok) throw new Error("VNPay unavailable");
      data = await response.json() as Record<string, unknown>;
    } catch { throw new BusinessError(502, "Chưa kết nối được VNPay để đối soát. Hãy thử lại sau."); }
    const fields = ["vnp_ResponseId", "vnp_Command", "vnp_ResponseCode", "vnp_Message", "vnp_TmnCode",
      "vnp_TxnRef", "vnp_Amount", "vnp_BankCode", "vnp_PayDate", "vnp_TransactionNo", "vnp_TransactionType",
      "vnp_TransactionStatus", "vnp_OrderInfo", "vnp_PromotionCode", "vnp_PromotionAmount"];
    const signature = data?.vnp_SecureHash;
    if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature) ||
      fields.some(key => data[key] !== undefined && typeof data[key] !== "string") ||
      !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(hash(fields.map(key => data[key] ?? "").join("|")), "hex")) ||
      data.vnp_TmnCode !== this.config.tmnCode || data.vnp_TxnRef !== attempt.id || data.vnp_Command !== "querydr")
      throw new BusinessError(502, "Không xác minh được phản hồi đối soát VNPay.");
    if (data.vnp_ResponseCode !== "00" || !["00", "02"].includes(String(data.vnp_TransactionStatus))) return null;
    if (!/^[0-9]{1,12}$/.test(String(data.vnp_Amount)) || data.vnp_TransactionType !== "01" ||
      (data.vnp_TransactionStatus === "00" && !/^[1-9]\d*$/.test(String(data.vnp_TransactionNo))))
      throw new BusinessError(502, "Dữ liệu đối soát VNPay không hợp lệ.");
    return { reference: attempt.id, amount: Number(data.vnp_Amount) / 100, success: data.vnp_TransactionStatus === "00",
      transactionNo: String(data.vnp_TransactionNo || "0"), responseCode: String(data.vnp_TransactionStatus) };
  }
  verify(query: Record<string, unknown>) {
    if (!this.enabled()) return null;
    const signature = query.vnp_SecureHash;
    if (typeof signature !== "string" || !/^[a-f0-9]{128}$/i.test(signature)) return null;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (!key.startsWith("vnp_") || ["vnp_SecureHash", "vnp_SecureHashType"].includes(key)) continue;
      if (typeof value !== "string") return null; // duplicate query keys / nested objects are invalid
      params[key] = value;
    }
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signVnpay(params, this.config.hashSecret), "hex"))) return null;
    if (params.vnp_TmnCode !== this.config.tmnCode || !/^[0-9]{1,12}$/.test(params.vnp_Amount ?? "") || !params.vnp_TxnRef ||
      !/^\d{2}$/.test(params.vnp_ResponseCode ?? "") || !/^\d{2}$/.test(params.vnp_TransactionStatus ?? "")) return null;
    // Pending, reversal and refund statuses must not release the invoice for another charge.
    if (!["00", "02"].includes(params.vnp_TransactionStatus) ||
      (params.vnp_TransactionStatus === "00" && params.vnp_ResponseCode !== "00")) return null;
    const success = params.vnp_ResponseCode === "00" && params.vnp_TransactionStatus === "00";
    if (success && !/^[1-9]\d*$/.test(params.vnp_TransactionNo ?? "")) return null;
    return { reference: params.vnp_TxnRef, amount: Number(params.vnp_Amount) / 100, success,
      transactionNo: params.vnp_TransactionNo || "0", responseCode: params.vnp_ResponseCode };
  }
}
