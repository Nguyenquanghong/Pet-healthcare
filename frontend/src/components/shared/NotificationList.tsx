import { useAppStore } from "../../store/AppStoreProvider";

export function NotificationList() {
  const { currentOwnerId, markNotificationRead, notifications } = useAppStore();
  const ownerNotifications = notifications.filter((notification) => notification.recipientOwnerId === currentOwnerId);

  return (
    <div className="space-y-3">
      {ownerNotifications.map((notification) => (
        <div key={notification.id} className={`rounded-xl border p-4 text-sm ${notification.status === "read" ? "border-slate-200 bg-slate-50" : "border-cyan-200 bg-cyan-50"}`}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-bold text-slate-900">{notification.title}</p>
              <p className="mt-1 text-slate-600">{notification.message}</p>
            </div>
            {notification.status !== "read" && <button onClick={() => markNotificationRead(notification.id)} className="shrink-0 rounded-lg bg-white px-3 py-1 text-xs font-bold text-primary shadow-sm">Đã đọc</button>}
          </div>
        </div>
      ))}
    </div>
  );
}