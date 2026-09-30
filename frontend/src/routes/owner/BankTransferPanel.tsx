import { useState } from "react";
import type { Invoice } from "../../types/invoice";
import { formatCurrency } from "../../utils/formatCurrency";
import { VietQrImage } from "./VietQrImage";

export function BankTransferPanel({ invoice, busy, onReport }: {
  invoice: Invoice; busy: boolean; onReport: (reference: string) => void;
}) {
  const [reference, setReference] = useState(invoice.transferReference || "");
  const [copyMessage, setCopyMessage] = useState("");
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopyMessage("Đã sao chép."); }
    catch { setCopyMessage("Không sao chép được. Hãy chọn và sao chép phần thông tin bên trên."); }
  };
  const details = invoice.bankTransferDetails;
  if (!details) return <p className="text-sm text-amber-700">Chưa có thông tin tài khoản nhận tiền. Vui lòng liên hệ cửa hàng.</p>;
  return <section aria-label="Thông tin chuyển khoản" className="my-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
    <h3 className="font-bold">Thông tin chuyển khoản</h3>
    {details.isDemo && <p className="font-bold text-amber-800">Thông tin minh họa — Không chuyển tiền thật.</p>}
    <dl className="grid gap-2 sm:grid-cols-[140px_1fr]">
      <dt>Ngân hàng</dt><dd className="font-semibold">{details.bankName}</dd>
      <dt>Số tài khoản</dt><dd className="break-all font-semibold">{details.accountNumber}</dd>
      <dt>Chủ tài khoản</dt><dd className="font-semibold">{details.accountHolder}</dd>
      <dt>Số tiền</dt><dd className="font-semibold">{formatCurrency(invoice.totalAmount)}</dd>
      <dt>Nội dung chuyển</dt><dd className="break-all font-semibold">{invoice.transferContent}</dd>
    </dl>
    {invoice.transferReviewStatus === "pending" ? <p role="status" className="font-semibold text-amber-800">Đã báo chuyển khoản · Chờ cửa hàng xác nhận. Không chuyển thêm tiền.</p> : <>
      {invoice.transferReviewStatus === "rejected" && <p className="text-rose-700">Cửa hàng chưa xác nhận: {invoice.transferReviewNote}. Hãy kiểm tra giao dịch cũ trước khi chuyển thêm.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="underline" onClick={() => void copy(details.accountNumber)}>Sao chép số tài khoản</button>
        <button type="button" className="underline" onClick={() => void copy(invoice.transferContent)}>Sao chép nội dung</button>
      </div>
      {copyMessage && <p role="status">{copyMessage}</p>}
      {!details.isDemo && (details.bankBin && invoice.transferContent.length <= 25
        ? <VietQrImage invoiceId={invoice.id} content={invoice.transferContent} />
        : <p>Hóa đơn này dùng thông tin chuyển khoản cũ và chưa hỗ trợ VietQR. Hãy giữ nguyên nội dung chuyển khoản bên trên.</p>)}
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); onReport(reference); }}>
        <label className="block">Mã giao dịch ngân hàng (không bắt buộc)
          <input className="mt-1 w-full rounded-lg border bg-white p-2" maxLength={100} disabled={busy} value={reference} onChange={e => setReference(e.target.value)} />
        </label>
        <p>Nhân viên kiểm tra tiền nhận trước khi xác nhận hóa đơn đã thanh toán.</p>
        <button disabled={busy} className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50">Tôi đã chuyển khoản</button>
      </form>
    </>}
  </section>;
}
