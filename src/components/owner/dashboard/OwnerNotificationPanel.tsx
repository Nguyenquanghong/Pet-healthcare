import { Link } from "react-router-dom";
import { Bell, ArrowRight, Clock } from "lucide-react";
import { useAppStore } from "../../../store/AppStoreProvider";

const TYPE_ICON: Record<string, string> = {
  appointment_confirmed: "✅",
  appointment_reminder: "🔔",
  appointment_cancelled: "❌",
  vaccination_reminder: "💉",
  hotel_booking_confirmed: "🏨",
  hotel_booking_created: "🏨",
  hotel_daily_update: "🐾",
  hotel_checked_out: "🎉",
  medical_record_updated: "📋",
  promotion: "🏷️",
  general: "📢",
};

function timeAgo(iso: string): string {
  try {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return "Vừa xong";
    if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
    return `${Math.floor(diff / 86400)} ngày trước`;
  } catch {
    return "Gần đây";
  }
}

export function OwnerNotificationPanel() {
  const { notifications, currentOwnerId, markNotificationRead } = useAppStore();

  const myNotifications = notifications.filter((n) => n.recipientOwnerId === currentOwnerId);

  if (myNotifications.length === 0) {
    return (
      <div className="py-6 text-center">
        <Bell className="mx-auto text-slate-300 mb-2" size={32} />
        <p className="text-sm font-medium text-slate-500">Chưa có thông báo nào.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-slate-100">
      {myNotifications.slice(0, 4).map((notif) => {
        const isUnread = notif.status === "sent";

        return (
          <div
            key={notif.id}
            onClick={() => isUnread && markNotificationRead(notif.id)}
            className={`flex cursor-pointer items-start gap-3 py-3.5 first:pt-0 ${
              isUnread ? "bg-slate-50" : "bg-white"
            }`}
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-base">
              {TYPE_ICON[notif.type] ?? "📢"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className={`text-sm font-bold truncate ${isUnread ? "text-slate-900" : "text-slate-700"}`}>
                  {notif.title}
                </p>
                {isUnread && <div className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />}
              </div>
              <p className="mt-0.5 text-xs text-slate-600 line-clamp-2 leading-relaxed">{notif.message}</p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
                <Clock size={10} /> {timeAgo(notif.createdAt)}
              </p>
            </div>
          </div>
        );
      })}

      <div className="pt-2 border-t border-slate-100 text-right">
        <Link
          to="/owner/notifications"
          className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
        >
          Xem tất cả thông báo ({myNotifications.length}) <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  );
}
