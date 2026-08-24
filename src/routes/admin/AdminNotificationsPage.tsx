import { useState } from "react";
import { Bell, CheckCheck, Clock, Send } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";

const TEMPLATES = [
  { id: "reminder", label: "Nhắc lịch khám", body: "Nhắc nhở: Thú cưng của bạn có lịch khám sắp tới tại Bệnh viện Thú y Mỹ Đình. Vui lòng đến đúng giờ." },
  { id: "vaccine", label: "Nhắc tiêm phòng", body: "Thú cưng của bạn sắp đến hạn tiêm phòng định kỳ. Hãy đặt lịch ngay để đảm bảo sức khỏe cho bé." },
  { id: "promo", label: "Khuyến mãi", body: "🎉 Ưu đãi đặc biệt tháng này: Giảm 20% dịch vụ Spa & Tắm sấy cho thú cưng. Đặt lịch ngay!" },
  { id: "checkin", label: "Nhắc check-in hotel", body: "Nhắc nhở: Thú cưng của bạn có lịch nhận phòng tại Nippon Pet Care Hotel. Vui lòng có mặt đúng giờ." },
  { id: "custom", label: "Tùy chỉnh", body: "" },
];

export function AdminNotificationsPage() {
  const { notifications, owners, markAllNotificationsRead, sendCustomNotification, markNotificationRead } = useAppStore();
  const [templateId, setTemplateId] = useState("reminder");
  const [recipientId, setRecipientId] = useState(owners[0]?.id ?? "");
  const [customTitle, setCustomTitle] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [sent, setSent] = useState(false);

  const selectedTemplate = TEMPLATES.find(t => t.id === templateId) ?? TEMPLATES[0];
  const title = templateId === "custom" ? customTitle : selectedTemplate.label;
  const body = templateId === "custom" ? customBody : selectedTemplate.body;

  const handleSend = () => {
    if (!recipientId || !title || !body) return;
    sendCustomNotification(recipientId, title, body);
    setSent(true);
    setCustomTitle("");
    setCustomBody("");
    setTimeout(() => setSent(false), 3000);
  };

  const unread = notifications.filter(n => n.status === "sent");

  return (
    <AdminLayout title="Thông báo">
      <div className="grid gap-8 xl:grid-cols-[1fr_1.4fr]">
        {/* Composer */}
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm h-fit">
          <h2 className="mb-5 text-xl font-bold text-slate-900 flex items-center gap-2">
            <Send size={20} className="text-primary" />
            Gửi thông báo
          </h2>

          {sent && (
            <div className="mb-4 flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm font-semibold text-emerald-800">
              <CheckCheck size={16} /> Đã gửi thông báo thành công!
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Người nhận</label>
              <select
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                value={recipientId}
                onChange={e => setRecipientId(e.target.value)}
              >
                {owners.map(o => <option key={o.id} value={o.id}>{o.fullName}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Loại thông báo</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTemplateId(t.id)}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors text-left ${
                      templateId === t.id
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-slate-200 text-slate-600 hover:border-slate-300"
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
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Tiêu đề</label>
                  <input
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    value={customTitle}
                    onChange={e => setCustomTitle(e.target.value)}
                    placeholder="Tiêu đề thông báo..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Nội dung</label>
                  <textarea
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary min-h-28"
                    value={customBody}
                    onChange={e => setCustomBody(e.target.value)}
                    placeholder="Nội dung thông báo..."
                  />
                </div>
              </>
            ) : (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
                <p className="text-xs font-bold text-slate-500 mb-2">Xem trước nội dung:</p>
                <p className="text-sm font-semibold text-slate-900 mb-1">{selectedTemplate.label}</p>
                <p className="text-sm text-slate-600 leading-relaxed">{selectedTemplate.body}</p>
              </div>
            )}

            <button
              onClick={handleSend}
              disabled={!recipientId || !title || !body}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-soft"
            >
              <Send size={16} /> Gửi thông báo
            </button>
          </div>
        </div>

        {/* Notification History */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
            <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Bell size={20} className="text-primary" />
              Lịch sử thông báo
              {unread.length > 0 && (
                <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs font-bold text-white">
                  {unread.length} chưa đọc
                </span>
              )}
            </h2>
            {unread.length > 0 && (
              <button
                onClick={markAllNotificationsRead}
                className="text-sm font-semibold text-primary hover:underline"
              >
                Đánh dấu tất cả đã đọc
              </button>
            )}
          </div>

          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {notifications.length === 0 && (
              <p className="px-6 py-12 text-center text-slate-400">Chưa có thông báo nào.</p>
            )}
            {notifications.map(n => {
              const recipient = owners.find(o => o.id === n.recipientOwnerId);
              return (
                <div
                  key={n.id}
                  className={`flex items-start gap-4 px-6 py-4 transition-colors ${n.status === "sent" ? "bg-blue-50/50" : ""}`}
                >
                  <div className={`mt-0.5 flex-shrink-0 h-9 w-9 flex items-center justify-center rounded-full ${n.status === "sent" ? "bg-primary/10" : "bg-slate-100"}`}>
                    {n.status === "sent"
                      ? <Bell size={16} className="text-primary" />
                      : <Clock size={16} className="text-slate-400" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`font-semibold text-sm ${n.status === "sent" ? "text-slate-900" : "text-slate-600"}`}>
                        {n.title}
                      </p>
                      {n.status === "sent" && (
                        <button
                          onClick={() => markNotificationRead(n.id)}
                          className="flex-shrink-0 text-xs text-primary hover:underline"
                        >
                          Đọc
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{n.message}</p>
                    <p className="text-xs text-slate-400 mt-1">→ {recipient?.fullName ?? n.recipientOwnerId}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}