import { LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { ownerNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";
import { BrandLogo } from "../../shared/BrandLogo";

export function OwnerSidebar() {
  const navigate = useNavigate();
  const { logout, notifications, currentOwnerId } = useAppStore();
  const unreadCount = notifications.filter(
    (n) => n.recipientOwnerId === currentOwnerId && n.status === "sent"
  ).length;

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col bg-primary p-5 text-white shadow-2xl lg:flex">
      {/* Brand */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-white p-1.5 ring-1 ring-white/20">
            <BrandLogo className="h-full w-full" />
          </div>
          <div>
            <div className="text-base font-extrabold tracking-wide">NIPOPETO</div>
            <div className="mt-0.5 text-[10px] font-medium leading-4 text-cyan-100">
              <span className="block">Công Nghệ Nhật Bản -</span>
              <span className="block">Tận Tâm Chăm Sóc Thú Cưng</span>
            </div>
          </div>
        </div>

      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1">
        {ownerNav.map((item) => {
          const Icon = item.icon;
          const isNotif = item.to === "/owner/notifications";
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/owner/dashboard"}
              className={({ isActive }) =>
                `flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${
                  isActive
                    ? "bg-white/20 text-white shadow-soft ring-1 ring-white/20"
                    : "text-cyan-100/80 hover:bg-white/10 hover:text-white"
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

      {/* Bottom: Logout */}
      <div className="mt-auto border-t border-white/10 pt-4">
        <button
          type="button"
          id="owner-sidebar-logout"
          onClick={handleLogout}
          aria-label="Đăng xuất tài khoản"
          className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-center text-sm font-semibold text-cyan-100 transition hover:bg-rose-500/15 hover:text-rose-100"
        >
          <LogOut size={16} /> Đăng xuất
        </button>
      </div>
    </aside>
  );
}
