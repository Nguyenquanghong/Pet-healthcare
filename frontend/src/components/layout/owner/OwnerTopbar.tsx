import { Bell } from "lucide-react";
import { NavLink } from "react-router-dom";
import { ownerNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";

interface OwnerTopbarProps {
  title: string;
}

export function OwnerTopbar({ title }: OwnerTopbarProps) {
  const { notifications, currentOwner, currentOwnerId } = useAppStore();
  const unreadCount = notifications.filter(
    (n) => n.recipientOwnerId === currentOwnerId && n.status === "sent"
  ).length;
  const initials = currentOwner?.fullName
    ? currentOwner.fullName
        .split(" ")
        .slice(-2)
        .map((word) => word[0])
        .join("")
        .toUpperCase()
    : "ON";

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div className="flex min-h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <h1 className="truncate text-lg font-semibold text-slate-950 sm:text-xl">{title}</h1>

        <div className="flex items-center gap-2">
          <NavLink
            to="/owner/profile"
            aria-label="Manage profile"
            title="Manage profile"
            className="flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-slate-100"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-primary">
              {initials}
            </div>
            <p className="hidden max-w-40 truncate text-sm font-medium text-slate-800 sm:block">
              {currentOwner?.fullName ?? "Chủ nuôi"}
            </p>
          </NavLink>

          <NavLink
            id="owner-topbar-bell"
            to="/owner/notifications"
            aria-label="Thông báo"
            className="relative flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
          >
            <Bell size={18} />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </NavLink>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto border-t border-slate-100 px-4 py-2 lg:hidden">
        {ownerNav.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/owner/dashboard"}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-xs font-medium ${
                  isActive ? "bg-slate-100 text-primary" : "text-slate-600"
                }`
              }
            >
              <Icon size={15} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </header>
  );
}
