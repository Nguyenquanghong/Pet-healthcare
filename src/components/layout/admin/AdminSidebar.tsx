import { LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { adminNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";

export function AdminSidebar() {
  const navigate = useNavigate();
  const { logout, notifications } = useAppStore();
  const unreadCount = notifications.filter(n => n.status === "sent").length;

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col bg-slate-900 p-5 text-white lg:flex">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary font-extrabold text-white">
            NPC
          </div>
          <div>
            <div className="text-base font-extrabold tracking-wide">NIPPON PET CARE</div>
            <div className="text-xs text-slate-400">Hospital Admin</div>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3 rounded-xl bg-white/5 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/30 text-sm font-bold text-aqua">
            BS
          </div>
          <div>
            <p className="text-sm font-semibold">Bs. Mai Nguyễn</p>
            <p className="text-xs text-slate-400">Bác sĩ thú y</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1">
        {adminNav.map((item) => {
          const Icon = item.icon;
          const isNotif = item.to === "/admin/notifications";
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${
                  isActive
                    ? "bg-primary text-white shadow-soft"
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                }`
              }
            >
              <span className="flex items-center gap-3">
                <Icon size={18} />
                {item.label}
              </span>
              {isNotif && unreadCount > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-xs font-bold text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto">
        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/5 px-4 py-3 text-center text-sm font-semibold text-slate-400 transition hover:bg-white/10 hover:text-white"
        >
          <LogOut size={16} /> Đăng xuất
        </button>
      </div>
    </aside>
  );
}
