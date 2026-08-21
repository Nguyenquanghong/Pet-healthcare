import { AppLayout } from "../../components/layout/AppLayout";
import { NotificationList } from "../../components/shared/NotificationList";
import { Card } from "../../components/ui/Card";
import { useAppStore } from "../../store/AppStoreProvider";

export function NotificationsPage() {
  const { markAllNotificationsRead } = useAppStore();
  return <AppLayout type="owner" title="Thông báo"><Card><div className="mb-4 flex justify-end"><button onClick={markAllNotificationsRead} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-primary hover:bg-slate-50">Đánh dấu tất cả đã đọc</button></div><NotificationList /></Card></AppLayout>;
}