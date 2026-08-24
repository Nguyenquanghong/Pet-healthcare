import { Link } from "react-router-dom";
import { ArrowRight, CalendarDays, Hotel, LockKeyhole, ShieldCheck, Stethoscope, UserPlus } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { AuthShell } from "./AuthShell";

const portals = [
  {
    to: "/login",
    icon: LockKeyhole,
    title: "Đăng nhập chủ nuôi",
    description: "Truy cập hồ sơ thú cưng, đặt lịch khám, lưu trú và thông báo cá nhân.",
    accent: "bg-primary/10 text-primary",
  },
  {
    to: "/register",
    icon: UserPlus,
    title: "Đăng ký chủ nuôi",
    description: "Tạo hồ sơ mới trong vài phút để bắt đầu sử dụng dịch vụ tại Nippon Pet Care.",
    accent: "bg-aqua text-primary",
  },
  {
    to: "/admin/login",
    icon: ShieldCheck,
    title: "Đăng nhập admin",
    description: "Cổng riêng cho bác sĩ và nhân viên quản trị bệnh viện.",
    accent: "bg-slate-950 text-white",
  },
];

export function LandingPage() {
  return (
    <AuthShell
      title="Chăm sóc thú cưng bắt đầu từ một cổng riêng tư"
      description="Chủ nuôi và nhân viên quản trị được tách thành hai luồng rõ ràng. Đăng nhập để đặt lịch, xem hồ sơ y tế, theo dõi khách sạn thú cưng và nhận thông báo cá nhân."
    >
      <div className="mb-6">
        <p className="text-sm font-extrabold uppercase tracking-[0.24em] text-primary">Chọn cổng truy cập</p>
        <h2 className="mt-2 text-3xl font-black text-slate-950">Bạn muốn tiếp tục với vai trò nào?</h2>
      </div>

      <div className="space-y-4">
        {portals.map((portal) => {
          const Icon = portal.icon;
          return (
            <Link key={portal.to} to={portal.to} className="group block">
              <Card className="flex items-center gap-4 border-white/80 bg-white/90 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.08)] transition duration-200 hover:-translate-y-1 hover:border-primary/20 hover:shadow-[0_22px_55px_rgba(0,63,112,0.16)]">
                <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${portal.accent}`}>
                  <Icon size={24} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-black text-slate-950">{portal.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-500">{portal.description}</p>
                </div>
                <ArrowRight className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-primary" size={22} />
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3 text-center text-xs font-bold text-slate-500">
        <div className="rounded-2xl bg-slate-50 p-3"><CalendarDays className="mx-auto mb-2 text-primary" size={18} />Đặt lịch</div>
        <div className="rounded-2xl bg-slate-50 p-3"><Stethoscope className="mx-auto mb-2 text-primary" size={18} />Hồ sơ y tế</div>
        <div className="rounded-2xl bg-slate-50 p-3"><Hotel className="mx-auto mb-2 text-primary" size={18} />Pet hotel</div>
      </div>
    </AuthShell>
  );
}