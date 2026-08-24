import { LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { ownerNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";

export function OwnerSidebar() {
  const navigate = useNavigate();
  const { logout, notifications, currentOwnerId, currentOwner } = useAppStore();
  const unreadCount = notifications.filter(
    (n) => n.recipientOwnerId === currentOwnerId && n.status === "sent"
  ).length;

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  // Initials from owner full name
  const initials = currentOwner?.fullName
    ? currentOwner.fullName
        .split(" ")
        .slice(-2)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
    : "ON";

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col bg-primary p-5 text-white shadow-2xl lg:flex">
      {/* Brand */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 font-extrabold text-white text-sm tracking-wide ring-1 ring-white/20">
            NPC
          </div>
          <div>
            <div className="text-base font-extrabold tracking-wide">NIPPON PET CARE</div>
            <div className="text-xs text-cyan-200">Chủ thú cưng</div>
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

      {/* Bottom: Owner profile + Logout */}
      <div className="mt-auto space-y-2">
        <div className="flex items-center gap-3 rounded-xl bg-white/10 p-3 ring-1 ring-white/10">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aqua/30 text-sm font-bold text-aqua ring-1 ring-aqua/30">
            {initials}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{currentOwner?.fullName ?? "Chủ nuôi"}</p>
            <p className="text-xs text-cyan-200">{currentOwner?.phone ?? ""}</p>
          </div>
        </div>
        <button
          type="button"
          id="owner-sidebar-logout"
          onClick={handleLogout}
          aria-label="Đăng xuất tài khoản"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 px-4 py-3 text-center text-sm font-semibold text-cyan-100 ring-1 ring-white/10 transition hover:bg-white/20 hover:text-white"
        >
          <LogOut size={16} /> Đăng xuất
        </button>
      </div>
    </aside>
  );
}
