import { useEffect, useState } from "react";
import { apiClient } from "../../services/apiClient";

export function VietQrImage({ invoiceId, content }: { invoiceId: string; content: string }) {
  const [dataUrl, setDataUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setDataUrl(""); setError("");
    apiClient.get<{ dataUrl: string }>(`/invoices/${invoiceId}/transfer-qr`).then(result => {
      if (active) setDataUrl(result.dataUrl);
    }).catch(() => {
      if (active) setError("Chưa tải được QR. Bạn vẫn có thể nhập thông tin chuyển khoản bên trên.");
    });
    return () => { active = false; };
  }, [invoiceId, attempt]);
  return <div className="space-y-2">
    <p className="font-semibold">Quét VietQR bằng ứng dụng ngân hàng</p>
    {error ? <div role="status"><p>{error}</p><button type="button" className="mt-2 underline" onClick={() => setAttempt(n => n + 1)}>Tải lại QR</button></div>
      : dataUrl ? <>
        <img src={dataUrl} width={320} height={320} alt={`VietQR thanh toán ${content}`} className="h-auto max-w-full rounded-lg bg-white" />
        <a href={dataUrl} download={`${content}.png`} className="inline-block font-semibold underline">Tải mã QR</a>
      </> : <p role="status">Đang tạo mã QR…</p>}
    <p>QR điền sẵn số tiền và nội dung chuyển khoản. Kiểm tra người nhận và số tiền trong ứng dụng ngân hàng trước khi xác nhận.</p>
  </div>;
}
