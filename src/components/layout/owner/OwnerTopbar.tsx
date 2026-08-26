import { Bell } from "lucide-react";
import { NavLink } from "react-router-dom";
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
    <header className="sticky top-0 z-10 flex flex-col gap-4 border-b border-slate-200 bg-canvas/90 px-5 py-5 backdrop-blur md:flex-row md:items-center md:justify-between lg:px-8">
      <div>
        <p className="text-sm font-semibold text-primary">Chủ thú cưng</p>
        <h1 className="text-2xl font-extrabold text-slate-950">{title}</h1>
      </div>

      <div className="flex w-full items-center justify-end gap-3 md:w-auto">
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-xs">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-black text-primary ring-1 ring-primary/10">
            {initials}
          </div>
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-sm font-bold text-slate-900">{currentOwner?.fullName ?? "Chủ nuôi"}</p>
            <p className="mt-0.5 text-xs font-medium text-slate-500">Chủ thú cưng</p>
          </div>
        </div>

        <NavLink
          id="owner-topbar-bell"
          to="/owner/notifications"
          aria-label="Thông báo"
          className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors shadow-xs"
        >
          <Bell size={20} />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold text-white shadow-xs">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </NavLink>
      </div>
    </header>
  );
}
