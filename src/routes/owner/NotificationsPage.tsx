import { Bell, CheckCheck, Clock } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { useAppStore } from "../../store/AppStoreProvider";

const TYPE_ICON: Record<string, string> = {
  appointment_confirmed: "✅",
  appointment_reminder: "🔔",
  appointment_cancelled: "❌",
  vaccination_reminder: "💉",
  hotel_booking_confirmed: "🏨",
  hotel_booking_created: "🏨",
  hotel_daily_update: "🐾",
  medical_record_updated: "📋",
  general: "📢",
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "Vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}

export function NotificationsPage() {
  const { notifications, currentOwnerId, markNotificationRead, markAllNotificationsRead } = useAppStore();
  const myNotifications = notifications.filter(n => n.recipientOwnerId === currentOwnerId);
  const unreadCount = myNotifications.filter(n => n.status === "sent").length;

  return (
    <OwnerLayout title="Thông báo">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-slate-900">Thông báo của bạn</h2>
            {unreadCount > 0 ? (
              <p className="text-sm text-primary font-semibold mt-0.5">{unreadCount} chưa đọc</p>
            ) : (
              <p className="text-sm text-slate-500 mt-0.5">Tất cả đã đọc</p>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllNotificationsRead}
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
            >
              <CheckCheck size={16} />
              Đánh dấu tất cả đã đọc
            </button>
          )}
        </div>

        {myNotifications.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 py-20">
            <Bell size={40} className="text-slate-300 mb-4" />
            <p className="font-bold text-slate-500">Chưa có thông báo nào</p>
          </div>
        )}

        <div className="space-y-3">
          {myNotifications.map(n => {
            const isUnread = n.status === "sent";
            return (
              <div
                key={n.id}
                className={`flex items-start gap-4 rounded-2xl border p-5 transition-all cursor-pointer hover:shadow-sm ${
                  isUnread
                    ? "border-primary/20 bg-blue-50/60"
                    : "border-slate-200 bg-white"
                }`}
                onClick={() => isUnread && markNotificationRead(n.id)}
              >
                <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl text-2xl ${isUnread ? "bg-primary/10" : "bg-slate-100"}`}>
                  {TYPE_ICON[n.type] ?? "📨"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className={`font-bold ${isUnread ? "text-slate-900" : "text-slate-700"}`}>
                      {n.title}
                    </p>
                    {isUnread && (
                      <div className="flex-shrink-0 h-2.5 w-2.5 rounded-full bg-primary mt-1.5" />
                    )}
                  </div>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed">{n.message}</p>
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
                    <Clock size={12} />
                    {timeAgo(n.createdAt)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </OwnerLayout>
  );
}