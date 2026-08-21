import { AppLayout } from "../../components/layout/AppLayout";
import { NotificationList } from "../../components/shared/NotificationList";
import { Card } from "../../components/ui/Card";

export function NotificationsPage() {
  return <AppLayout type="owner" title="Thông báo"><Card><NotificationList /></Card></AppLayout>;
}