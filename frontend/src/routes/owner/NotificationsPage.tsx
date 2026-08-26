import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck, Clock, Trash2, ArrowRight, X } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Notification, NotificationType } from "../../types/notification";

const TYPE_ICON: Record<string, string> = {
  appointment_created: "📅",
  appointment_confirmed: "✅",
  appointment_reminder: "🔔",
  appointment_cancelled: "❌",
  appointment_rescheduled: "🗓️",
  vaccination_reminder: "💉",
  hotel_booking_created: "🏨",
  hotel_booking_confirmed: "🏨",
  hotel_booking_cancelled: "🚫",
  hotel_daily_update: "🐾",
  hotel_checked_out: "🏠",
  medical_record_updated: "📋",
  promotion: "🎁",
  general: "📢",
};

const CATEGORY_MAP: Record<string, NotificationType[]> = {
  all: [],
  appointments: [
    "appointment_created",
    "appointment_confirmed",
    "appointment_reminder",
    "appointment_cancelled",
    "appointment_rescheduled",
  ],
  hotel: [
    "hotel_booking_created",
    "hotel_booking_confirmed",
    "hotel_booking_cancelled",
    "hotel_daily_update",
    "hotel_checked_out",
  ],
  medical: ["medical_record_updated", "vaccination_reminder"],
  promo: ["promotion", "general"],
};

const TABS = [
  { key: "all", label: "Tất cả" },
  { key: "appointments", label: "Lịch khám" },
  { key: "hotel", label: "Khách sạn" },
  { key: "medical", label: "Bệnh án" },
  { key: "promo", label: "Khuyến mãi & Khác" },
];

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "Vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const {
    notifications,
    currentOwnerId,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState("all");

  const myNotifications = useMemo(() => {
    return notifications.filter(
      (n) => n.recipientOwnerId === currentOwnerId && n.recipientRole !== "admin"
    );
  }, [notifications, currentOwnerId]);

  const filteredNotifications = useMemo(() => {
    if (activeTab === "all") return myNotifications;
    const allowedTypes = CATEGORY_MAP[activeTab] ?? [];
    return myNotifications.filter((n) => allowedTypes.includes(n.type));
  }, [myNotifications, activeTab]);

  const unreadCount = myNotifications.filter((n) => n.status === "sent").length;

  const handleNotificationClick = (n: Notification) => {
    if (n.status === "sent") {
      markNotificationRead(n.id);
    }
    if (n.actionUrl) {
      navigate(n.actionUrl);
    }
  };

  return (
    <OwnerLayout title="Thông báo">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-slate-900">Thông báo của bạn</h2>
            {unreadCount > 0 ? (
              <p className="text-sm text-primary font-semibold mt-0.5">
                Bạn có {unreadCount} thông báo chưa đọc
              </p>
            ) : (
              <p className="text-sm text-slate-500 mt-0.5">Đã đọc tất cả thông báo</p>
            )}
          </div>

          {unreadCount > 0 && (
            <button
              onClick={markAllNotificationsRead}
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors shadow-xs"
            >
              <CheckCheck size={16} className="text-primary" />
              Đánh dấu tất cả đã đọc
            </button>
          )}
        </div>

        {/* Filter Tabs */}
        <div className="mb-6 flex flex-wrap gap-2 pb-2 border-b border-slate-200">
          {TABS.map((tab) => {
            const count =
              tab.key === "all"
                ? myNotifications.length
                : myNotifications.filter((n) => (CATEGORY_MAP[tab.key] ?? []).includes(n.type)).length;

            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                  activeTab === tab.key
                    ? "bg-primary text-white border-primary shadow-xs"
                    : "bg-white text-slate-600 border-slate-200 hover:border-primary/40"
                }`}
              >
                {tab.label}
                <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px]">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Empty State */}
        {filteredNotifications.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
            <Bell size={40} className="text-slate-300 mb-3" />
            <p className="font-bold text-slate-600">Không có thông báo nào trong danh mục này</p>
            <p className="text-xs text-slate-400 mt-1">Các cập nhật quan trọng từ phòng khám sẽ hiển thị tại đây.</p>
          </div>
        )}

        {/* Notification Cards */}
        <div className="space-y-3">
          {filteredNotifications.map((n) => {
            const isUnread = n.status === "sent";

            return (
              <div
                key={n.id}
                className={`group relative flex items-start gap-4 rounded-2xl border p-5 transition-all hover:shadow-md ${
                  isUnread
                    ? "border-primary/30 bg-blue-50/70"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div
                  onClick={() => handleNotificationClick(n)}
                  className={`flex h-12 w-12 flex-shrink-0 cursor-pointer items-center justify-center rounded-2xl text-2xl ${
                    isUnread ? "bg-primary/10 shadow-xs" : "bg-slate-100"
                  }`}
                >
                  {TYPE_ICON[n.type] ?? "📨"}
                </div>

                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => handleNotificationClick(n)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className={`font-bold ${isUnread ? "text-slate-900" : "text-slate-700"}`}>
                      {n.title}
                    </p>
                    {isUnread && (
                      <span className="flex-shrink-0 h-2.5 w-2.5 rounded-full bg-primary mt-1.5 shadow-xs" />
                    )}
                  </div>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed">{n.message}</p>

                  <div className="mt-3 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-slate-400 font-medium">
                      <Clock size={12} />
                      {timeAgo(n.createdAt)}
                    </span>

                    {n.actionUrl && (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-primary group-hover:underline">
                        Xem chi tiết <ArrowRight size={12} />
                      </span>
                    )}
                  </div>
                </div>

                {/* Delete button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNotification(n.id);
                  }}
                  title="Xóa thông báo"
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </OwnerLayout>
  );
}