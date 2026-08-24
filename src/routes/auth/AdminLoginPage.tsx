import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { useAppStore } from "../../store/AppStoreProvider";
import { AuthShell } from "./AuthShell";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const { loginAdmin } = useAppStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loginAdmin(username, password)) {
      setError("Sai tài khoản hoặc mật khẩu admin.");
      return;
    }
    navigate("/admin/dashboard", { replace: true });
  };

  return (
    <AuthShell
      eyebrow="Admin Portal"
      title="Khu vực quản trị an toàn"
      description="Cổng dành riêng cho bác sĩ và nhân viên vận hành để quản lý lịch hẹn, hồ sơ thú cưng, thông báo và hoạt động bệnh viện."
      tone="admin"
    >
      <Card className="border-slate-800 bg-slate-900 p-6 text-white shadow-[0_24px_70px_rgba(0,0,0,0.28)] lg:p-8">
        <div className="mb-6">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-aqua text-primary"><ShieldCheck /></div>
          <p className="text-sm font-extrabold uppercase tracking-[0.22em] text-aqua">Bảo mật nội bộ</p>
          <h1 className="mt-2 text-3xl font-black">Đăng nhập admin</h1>
          <p className="mt-2 text-sm text-slate-400">Demo: <span className="font-bold text-white">admin</span> / <span className="font-bold text-white">admin123</span>.</p>
        </div>
        {error && <div className="mb-4 rounded-xl bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-300">{error}</div>}
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input label="Tài khoản" labelClassName="text-slate-200" value={username} onChange={(event) => { setUsername(event.target.value); setError(""); }} placeholder="admin" />
          <Input type="password" label="Mật khẩu" labelClassName="text-slate-200" value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} placeholder="admin123" />
          <Button type="submit" size="lg" className="w-full" icon={<LockKeyhole size={18} />}>Đăng nhập admin</Button>
        </form>
        <Link to="/" className="mt-5 block text-center text-sm font-semibold text-slate-400 hover:text-white">Về trang chọn cổng</Link>
      </Card>
    </AuthShell>
  );
}