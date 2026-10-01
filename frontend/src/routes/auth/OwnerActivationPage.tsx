import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { apiClient } from "../../services/apiClient";
import { ApiError } from "../../utils/apiError";
import { AuthShell } from "./AuthShell";

export function OwnerActivationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") || "");
  const [details, setDetails] = useState<{ email: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(""); setInvalid(false);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setError("Liên kết kích hoạt không hợp lệ. Liên hệ cửa hàng để được cấp lại."); setInvalid(true); setLoading(false);
      return;
    }
    apiClient.post<{ email: string; expiresAt: string }>("/auth/owner/activation/inspect", { token })
      .then(result => { if (!disposed) setDetails(result); })
      .catch(reason => { if (!disposed) {
        setError(reason instanceof Error ? reason.message : "Chưa kiểm tra được liên kết.");
        setInvalid(reason instanceof ApiError && reason.httpStatus === 422);
      } }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [token, attempt]);

  async function activate(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !details || invalid || success) return;
    if (password !== confirmPassword) { setError("Mật khẩu xác nhận chưa khớp."); return; }
    submitting.current = true; setBusy(true); setError("");
    try {
      await apiClient.post("/auth/owner/activation", { token, password, confirmPassword });
      setPassword(""); setConfirmPassword(""); setSuccess(true);
      navigate("/activate-account", { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chưa kích hoạt được tài khoản.");
      if (reason instanceof ApiError && reason.httpStatus === 422 && !reason.message.includes("Mật khẩu")) setInvalid(true);
      // A lost response may have consumed the link. Ask the customer to try login instead of registering again.
      if (reason instanceof ApiError && reason.httpStatus >= 500) setError("Mất phản hồi từ máy chủ. Nếu đã kích hoạt, hãy thử đăng nhập bằng email và mật khẩu vừa đặt; nếu chưa được, liên hệ cửa hàng để kiểm tra.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <AuthShell title="Kích hoạt tài khoản" description="Đặt mật khẩu cho hồ sơ đã tạo tại cửa hàng.">
    <h2 className="mb-4 text-2xl font-semibold">Kích hoạt tài khoản</h2>
    {success ? <div className="space-y-4">
      <p role="status" className="rounded-lg bg-emerald-50 p-4 text-emerald-800">Đã kích hoạt tài khoản cho {details?.email}. Hồ sơ, thú cưng và lịch đặt của bạn được giữ nguyên.</p>
      <Link to="/login" className="font-semibold text-primary underline">Đăng nhập</Link>
    </div> : <>
      {loading && <p role="status">Đang kiểm tra liên kết...</p>}
      {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      {!loading && !details && !invalid && <Button type="button" variant="outline" onClick={() => setAttempt(value => value + 1)}>Thử kiểm tra lại</Button>}
      {!loading && details && !invalid && <form onSubmit={event => void activate(event)} className="space-y-4">
        <p>Email đăng nhập: <strong className="break-all">{details.email}</strong></p>
        <p className="text-sm text-slate-600">Hết hạn: {new Date(details.expiresAt).toLocaleString("vi-VN")}. Đặt mật khẩu riêng để sử dụng hồ sơ hiện có.</p>
        <fieldset disabled={busy} className="space-y-4">
          <Input label="Mật khẩu mới" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} />
          <Input label="Xác nhận mật khẩu" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} />
          <p className="text-sm text-slate-500">Mật khẩu từ 8 đến 128 ký tự.</p>
          <Button type="submit" className="w-full">{busy ? "Đang kích hoạt..." : "Đặt mật khẩu và kích hoạt"}</Button>
        </fieldset>
      </form>}
      <p className="mt-6 text-sm text-slate-600">Nếu liên kết hết hạn hoặc đã dùng, liên hệ cửa hàng. Nếu đã kích hoạt thành công, <Link to="/login" className="font-semibold text-primary underline">đăng nhập tại đây</Link>.</p>
    </>}
  </AuthShell>;
}
