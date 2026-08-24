import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LockKeyhole, PawPrint } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { useAppStore } from "../../store/AppStoreProvider";
import { AuthShell } from "./AuthShell";

export function OwnerLoginPage() {
  const navigate = useNavigate();
  const { loginOwner } = useAppStore();
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!phone.trim()) {
      setError("Vui lòng nhập số điện thoại.");
      return;
    }
    if (!loginOwner(phone)) {
      setError("Không tìm thấy tài khoản chủ nuôi với số điện thoại này.");
      return;
    }
    navigate("/owner/dashboard", { replace: true });
  };

  return (
    <AuthShell
      eyebrow="Owner Portal"
      title="Chào mừng bạn quay lại"
      description="Đăng nhập để xem lịch hẹn, hồ sơ y tế, thông báo và các dịch vụ dành riêng cho thú cưng của bạn."
    >
      <Card className="border-white/80 bg-white/95 p-6 shadow-[0_18px_55px_rgba(15,23,42,0.1)] lg:p-8">
        <div className="mb-6">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><PawPrint /></div>
          <p className="text-sm font-extrabold uppercase tracking-[0.22em] text-primary">Đăng nhập</p>
          <h1 className="mt-2 text-3xl font-black text-slate-950">Cổng chủ nuôi</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">Demo: dùng số điện thoại đã đăng ký, ví dụ <span className="font-bold text-slate-700">0901234567</span>.</p>
        </div>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input label="Số điện thoại" value={phone} error={error} onChange={(event) => { setPhone(event.target.value); setError(""); }} placeholder="0901234567" autoComplete="tel" />
          <Button type="submit" size="lg" className="w-full" icon={<LockKeyhole size={18} />}>Đăng nhập</Button>
        </form>
        <div className="mt-6 flex flex-col gap-3 text-sm font-semibold sm:flex-row sm:justify-between">
          <Link to="/register" className="text-primary hover:underline">Đăng ký tài khoản</Link>
          <Link to="/" className="text-slate-500 hover:text-primary">Về trang chọn cổng</Link>
        </div>
      </Card>
    </AuthShell>
  );
}