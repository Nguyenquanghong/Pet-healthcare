import { notifications } from "../../data/mockData";

export function NotificationList() {
  return (
    <div className="space-y-3">
      {notifications.map((notification) => (
        <div key={notification} className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
          {notification}
        </div>
      ))}
    </div>
  );
}