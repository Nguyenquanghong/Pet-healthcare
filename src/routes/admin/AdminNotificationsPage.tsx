import { AppLayout } from "../../components/layout/AppLayout";
import { Card } from "../../components/ui/Card";

export function AdminNotificationsPage() {
  return <AppLayout type="admin" title="Gửi thông báo"><Card title="Notification Composer"><textarea className="min-h-32 w-full rounded-xl border border-slate-200 p-4" defaultValue="Nhắc lịch khám: Mochi có lịch khám vào 09:00 ngày mai." /><button className="mt-4 rounded-xl bg-primary px-5 py-3 font-bold text-white">Send Notification</button></Card></AppLayout>;
}