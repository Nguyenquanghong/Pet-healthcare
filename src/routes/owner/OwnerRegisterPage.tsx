import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";
import { useAppStore } from "../../store/AppStoreProvider";
import { AuthShell } from "../auth/AuthShell";

type RegisterFormErrors = Partial<Record<"fullName" | "phone" | "email", string>>;

const phonePattern = /^(0|\+84)[0-9\s.-]{8,12}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OwnerRegisterPage() {
  const navigate = useNavigate();
  const { owners, registerOwner } = useAppStore();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const [created, setCreated] = useState(false);

  const existingPhones = useMemo(() => new Set(owners.map((owner) => owner.phone.trim())), [owners]);
  const existingEmails = useMemo(
    () => new Set(owners.map((owner) => owner.email?.trim().toLowerCase()).filter(Boolean)),
    [owners],
  );

  const validate = () => {
    const nextErrors: RegisterFormErrors = {};
    const normalizedPhone = phone.trim();
    const normalizedEmail = email.trim().toLowerCase();

    if (!fullName.trim()) nextErrors.fullName = "Vui lòng nhập họ và tên.";
    if (!normalizedPhone) nextErrors.phone = "Vui lòng nhập số điện thoại.";
    else if (!phonePattern.test(normalizedPhone)) nextErrors.phone = "Số điện thoại chưa đúng định dạng.";
    else if (existingPhones.has(normalizedPhone)) nextErrors.phone = "Số điện thoại này đã được đăng ký.";

    if (normalizedEmail) {
      if (!emailPattern.test(normalizedEmail)) nextErrors.email = "Email chưa đúng định dạng.";
      else if (existingEmails.has(normalizedEmail)) nextErrors.email = "Email này đã được đăng ký.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;

    registerOwner({
      fullName: fullName.trim(),
      phone: phone.trim(),
      email: email.trim() || undefined,
      address: address.trim() || undefined,
    });

    setCreated(true);
    setTimeout(() => navigate("/owner/pets", { replace: true }), 900);
  };

  return (
    <AuthShell
      eyebrow="Owner Portal"
      title="Tạo hồ sơ chủ nuôi mới"
      description="Đăng ký để quản lý thú cưng, đặt lịch khám, theo dõi hồ sơ y tế, nhận thông báo và sử dụng dịch vụ khách sạn thú cưng."
    >
        <Card className="border-white/80 bg-white/95 p-6 shadow-[0_18px_55px_rgba(15,23,42,0.1)] lg:p-8">
          <div className="mb-6">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <UserPlus size={24} />
            </div>
            <p className="text-sm font-extrabold uppercase tracking-[0.22em] text-primary">Đăng ký nhanh</p>
            <h2 className="mt-2 text-3xl font-black text-slate-950">Thông tin chủ nuôi</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">Các trường có dấu * là bắt buộc. Tài khoản sẽ tự đăng nhập sau khi tạo.</p>
          </div>

          {created && (
            <div className="mb-5 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              <CheckCircle2 size={16} /> Tạo tài khoản thành công! Đang chuyển sang bước thêm hồ sơ thú cưng...
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <Input
              label="Họ và tên *"
              value={fullName}
              error={errors.fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Ví dụ: Nguyễn Văn A"
              autoComplete="name"
            />
            <Input
              label="Số điện thoại *"
              value={phone}
              error={errors.phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="Ví dụ: 0901234567"
              autoComplete="tel"
            />
            <Input
              type="email"
              label="Email"
              value={email}
              error={errors.email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="owner@example.com"
              autoComplete="email"
            />
            <Textarea
              label="Địa chỉ"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Phường/xã, quận/huyện, thành phố..."
              rows={3}
            />
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
              <Button type="submit" size="lg" icon={<UserPlus size={18} />} className="w-full sm:w-auto">
                Tạo tài khoản chủ nuôi
              </Button>
              <Link to="/" className="text-center text-sm font-semibold text-slate-500 transition hover:text-primary">
                Quay lại trang chọn cổng
              </Link>
            </div>
          </form>
        </Card>
    </AuthShell>
  );
}