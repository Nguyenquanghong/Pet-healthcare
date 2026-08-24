import { LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { ownerNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";

export function OwnerSidebar() {
  const navigate = useNavigate();
  const { logout } = useAppStore();

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-primary px-4 py-3 text-white shadow-[0_18px_45px_rgba(0,63,112,0.18)] lg:px-8">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-3 xl:grid-cols-[280px_minmax(0,1fr)_140px] xl:items-center">
        <div className="flex items-center justify-between gap-3 xl:justify-start">
          <div>
            <div className="text-lg font-extrabold leading-tight tracking-wide sm:text-xl">NIPPON PET CARE</div>
            <div className="mt-0.5 text-[11px] font-medium text-cyan-100 sm:text-xs">Công Nghệ Nhật Bản</div>
          </div>
          <div className="flex h-8 shrink-0 items-center rounded-full bg-white/12 px-4 text-[11px] font-bold text-cyan-50 ring-1 ring-white/10">Owner Portal</div>
        </div>

        <nav className="flex gap-2 overflow-x-auto pb-1 xl:justify-center xl:overflow-visible xl:pb-0">
          {ownerNav.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/owner/dashboard"}
                className={({ isActive }) =>
                  `flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl px-3.5 text-[13px] font-bold transition xl:px-4 ${
                    isActive
                      ? "bg-aqua text-primary shadow-soft"
                      : "text-white/82 hover:bg-white/10 hover:text-white"
                  }`
                }
              >
                <Icon size={18} />
                <span className="whitespace-nowrap">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={handleLogout}
          className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl bg-white/12 px-4 text-[13px] font-bold transition hover:bg-white/20 xl:w-full"
        >
          <LogOut size={16} /> Đăng xuất
        </button>
      </div>
    </header>
  );
}
