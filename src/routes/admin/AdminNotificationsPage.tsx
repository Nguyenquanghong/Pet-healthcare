import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  CheckCheck,
  Clock,
  Send,
  Trash2,
  Inbox,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Notification } from "../../types/notification";

const TEMPLATES = [
  {
    id: "reminder",
    label: "Nhắc lịch khám",
    body: "Nhắc nhở: Thú cưng của bạn có lịch khám sắp tới tại Bệnh viện Thú y Mỹ Đình. Vui lòng đến đúng giờ.",
  },
  {
    id: "vaccine",
    label: "Nhắc tiêm phòng",
    body: "Thú cưng của bạn sắp đến hạn tiêm phòng định kỳ. Hãy đặt lịch ngay để đảm bảo sức khỏe cho bé.",
  },
  {
    id: "promo",
    label: "Khuyến mãi",
    body: "🎉 Ưu đãi đặc biệt tháng này: Giảm 20% dịch vụ Spa & Tắm sấy cho thú cưng. Đặt lịch ngay!",
  },
  {
    id: "checkin",
    label: "Nhắc check-in hotel",
    body: "Nhắc nhở: Thú cưng của bạn có lịch nhận phòng tại Nippon Pet Care Hotel. Vui lòng có mặt đúng giờ.",
  },
  { id: "custom", label: "Tùy chỉnh", body: "" },
];

const TYPE_ICON: Record<string, string> = {
  appointment_created: "📅",
  appointment_rescheduled: "🗓️",
  appointment_cancelled: "❌",
  hotel_booking_created: "🏨",
  hotel_booking_cancelled: "🚫",
  general: "📢",
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "Vừa xong";
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}

export function AdminNotificationsPage() {
  const navigate = useNavigate();
  const {
    notifications,
    owners,
    markAllNotificationsRead,
    sendCustomNotification,
    markNotificationRead,
    deleteNotification,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<"inbox" | "compose">("inbox");
  const [templateId, setTemplateId] = useState("reminder");
  const [recipientId, setRecipientId] = useState(owners[0]?.id ?? "");
  const [customTitle, setCustomTitle] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [sentMsg, setSentMsg] = useState("");

  const adminNotifications = useMemo(() => {
    return notifications.filter((n) => n.recipientRole === "admin");
  }, [notifications]);

  const unreadAdminCount = useMemo(() => {
    return adminNotifications.filter((n) => n.status === "sent").length;
  }, [adminNotifications]);

  const selectedTemplate = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const title = templateId === "custom" ? customTitle : selectedTemplate.label;
  const body = templateId === "custom" ? customBody : selectedTemplate.body;

  const handleSend = () => {
    if (!recipientId || !title || !body) return;
    sendCustomNotification(recipientId, title, body);
    setSentMsg("Đã gửi thông báo cho chủ nuôi thành công!");
    setCustomTitle("");
    setCustomBody("");
    setTimeout(() => setSentMsg(""), 3500);
  };

  const handleNotificationClick = (n: Notification) => {
    if (n.status === "sent") {
      markNotificationRead(n.id);
    }
    if (n.actionUrl) {
      navigate(n.actionUrl);
    }
  };

  return (
    <AdminLayout title="Thông báo hệ thống">
      {/* Top Tabs */}
      <div className="mb-6 flex items-center justify-between border-b border-slate-200 pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveTab("inbox")}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all ${
              activeTab === "inbox"
                ? "bg-slate-900 text-white shadow-xs"
                : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
            }`}
          >
            <Inbox size={18} />
            Hộp thư Admin
            {unreadAdminCount > 0 && (
              <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs font-bold text-white">
                {unreadAdminCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab("compose")}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all ${
              activeTab === "compose"
                ? "bg-primary text-white shadow-xs"
                : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
            }`}
          >
            <Send size={18} />
            Gửi thông báo cho Chủ nuôi
          </button>
        </div>

        {activeTab === "inbox" && unreadAdminCount > 0 && (
          <button
            onClick={markAllNotificationsRead}
            className="flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
          >
            <CheckCheck size={16} /> Đánh dấu tất cả đã đọc
          </button>
        )}
      </div>

      {sentMsg && (
        <div className="mb-6 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} /> {sentMsg}
        </div>
      )}

      {/* TAB 1: Admin Inbox */}
      {activeTab === "inbox" && (
        <div className="space-y-3 max-w-4xl">
          {adminNotifications.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
              <Bell size={40} className="text-slate-300 mb-3" />
              <p className="font-bold text-slate-600">Không có thông báo hệ thống nào</p>
              <p className="text-xs text-slate-400 mt-1">
                Các biến động từ chủ nuôi (đặt lịch, dời lịch, hủy lịch) sẽ hiển thị ở đây.
              </p>
            </div>
          )}

          {adminNotifications.map((n) => {
            const isUnread = n.status === "sent";

            return (
              <div
                key={n.id}
                className={`group relative flex items-start gap-4 rounded-2xl border p-5 transition-all hover:shadow-md ${
                  isUnread
                    ? "border-primary/30 bg-blue-50/60"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div
                  onClick={() => handleNotificationClick(n)}
                  className={`flex h-12 w-12 flex-shrink-0 cursor-pointer items-center justify-center rounded-2xl text-2xl ${
                    isUnread ? "bg-primary/10 shadow-xs" : "bg-slate-100"
                  }`}
                >
                  {TYPE_ICON[n.type] ?? "📢"}
                </div>

                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleNotificationClick(n)}>
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
                        Xử lý ngay <ArrowRight size={12} />
                      </span>
                    )}
                  </div>
                </div>

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
      )}

      {/* TAB 2: Compose Notification for Owner */}
      {activeTab === "compose" && (
        <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-5 text-xl font-bold text-slate-900 flex items-center gap-2">
            <Send size={20} className="text-primary" />
            Gửi thông báo tới Chủ nuôi
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Người nhận *
              </label>
              <select
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none"
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value)}
              >
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.fullName} ({o.phone})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Loại / Mẫu thông báo *
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTemplateId(t.id)}
                    className={`rounded-xl border px-3 py-2.5 text-xs font-bold transition-colors text-left ${
                      templateId === t.id
                        ? "border-primary bg-primary/10 text-primary shadow-xs"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {templateId === "custom" ? (
              <>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                    Tiêu đề *
                  </label>
                  <input
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="Nhập tiêu đề thông báo..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                    Nội dung *
                  </label>
                  <textarea
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none min-h-28"
                    value={customBody}
                    onChange={(e) => setCustomBody(e.target.value)}
                    placeholder="Nhập nội dung gửi chủ nuôi..."
                  />
                </div>
              </>
            ) : (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                  Xem trước nội dung:
                </p>
                <p className="text-sm font-bold text-slate-900">{selectedTemplate.label}</p>
                <p className="text-sm text-slate-600 leading-relaxed">{selectedTemplate.body}</p>
              </div>
            )}

            <button
              onClick={handleSend}
              disabled={!recipientId || !title || !body}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-soft"
            >
              <Send size={16} /> Gửi thông báo ngay
            </button>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}