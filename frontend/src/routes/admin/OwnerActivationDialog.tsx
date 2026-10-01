import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { apiClient } from "../../services/apiClient";
import type { Owner } from "../../types/owner";

type Invitation = { token: string; email: string; expiresAt: string };

export function OwnerActivationDialog({ owner, onClose }: { owner: Owner; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [email, setEmail] = useState(owner.email || "");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [reissuing, setReissuing] = useState(false);
  const link = invitation ? `${window.location.origin}/activate-account#token=${invitation.token}` : "";
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function issue(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !verified) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await apiClient.post<{ activation: Invitation }>(`/owners/${encodeURIComponent(owner.id)}/activation`, {
        email: email.trim(), customerVerified: true,
      });
      setInvitation(result.activation); setCopyFeedback(""); setReissuing(false);
    } catch (reason) {
      setError(`${reason instanceof Error ? reason.message : "Không cấp được liên kết."} Nếu bị mất phản hồi, cấp lại sẽ thu hồi liên kết trước đó.`);
    } finally { submitting.current = false; setBusy(false); }
  }

  return createPortal(<dialog ref={dialog} aria-labelledby="activation-title"
    onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}
    className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl p-6 text-slate-900 shadow-xl backdrop:bg-slate-900/50">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 id="activation-title" className="text-xl font-bold">Kích hoạt tài khoản</h2>
      <button type="button" aria-label="Đóng form" disabled={busy} onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={20} /></button>
    </div>
    <div className="mb-4 space-y-1 rounded-lg bg-slate-50 p-4 text-sm">
      <p className="font-bold">{owner.fullName}</p><p>Số điện thoại: {owner.phone || "Chưa có"}</p>
      <p className="break-all">Mã chủ nuôi: {owner.id}</p>
    </div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
    {invitation && !reissuing ? <div className="space-y-4">
      <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">Đã cấp liên kết cho {invitation.email}. Khách tự đặt mật khẩu; hồ sơ cũ được giữ nguyên.</p>
      <Input label="Liên kết kích hoạt" value={link} readOnly onFocus={event => event.target.select()} />
      <p className="text-sm">Hết hạn: {new Date(invitation.expiresAt).toLocaleString("vi-VN")} (30 phút kể từ lúc cấp). Chỉ dùng một lần.</p>
      <p className="text-sm text-slate-600">Sao chép và giao riêng cho đúng khách sau khi xác minh. Hệ thống chưa gửi email tự động. Khách mở liên kết trên thiết bị của mình rồi đăng nhập bằng email và mật khẩu vừa đặt.</p>
      {copyFeedback && <p role="status" className="text-sm text-slate-600">{copyFeedback}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => { setReissuing(true); setVerified(false); setError(""); }}>Cấp lại liên kết</Button>
        <Button type="button" variant="outline" onClick={async () => {
          try { await navigator.clipboard.writeText(link); setCopyFeedback("Đã sao chép liên kết."); }
          catch { setCopyFeedback("Không sao chép tự động được. Chọn ô liên kết và nhấn Ctrl+C."); }
        }}>Sao chép liên kết</Button>
        <Button type="button" onClick={onClose}>Đóng</Button>
      </div>
    </div> : <form onSubmit={event => void issue(event)} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        {reissuing && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Cấp lại thành công sẽ thu hồi liên kết cũ. Nếu khách đã kích hoạt, không thể dùng chức năng này để đổi mật khẩu.</p>}
        <Input label="Email đăng nhập của khách" type="email" required maxLength={254} autoFocus value={email} onChange={event => setEmail(event.target.value)} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" required checked={verified} onChange={event => setVerified(event.target.checked)} className="mt-1" />
          Tôi đã xác minh đúng khách, hồ sơ và email đăng nhập tại quầy.
        </label>
        <p className="text-sm text-slate-600">Liên kết có hiệu lực 30 phút. Email và mật khẩu chỉ được cập nhật khi khách hoàn tất kích hoạt. Không tạo thêm hồ sơ chủ nuôi.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => { if (invitation) { setReissuing(false); setError(""); } else onClose(); }}>{invitation ? "Quay lại" : "Hủy"}</Button>
          <Button type="submit" disabled={!verified}>{busy ? "Đang cấp..." : reissuing ? "Xác nhận cấp lại" : "Cấp liên kết kích hoạt"}</Button>
        </div>
      </fieldset>
    </form>}
  </dialog>, document.body);
}
