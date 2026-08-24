import { BadgeCheck, Tag } from "lucide-react";

export function OwnerNotificationPanel() {
  const notifications = [
    {
      id: 1,
      type: "info",
      title: "Hồ sơ tiêm phòng của Mochi đã được cập nhật thành công lên hệ thống Blockchain.",
      time: "2 giờ trước",
      icon: BadgeCheck,
    },
    {
      id: 2,
      type: "offer",
      title: "Ưu đãi 20% dịch vụ Spa & Tắm sấy khi đặt lịch qua Ứng dụng trong tháng 11.",
      time: "Hôm qua",
      icon: Tag,
    }
  ];

  return (
    <div className="space-y-4">
      {notifications.map((notif) => {
        const Icon = notif.icon;
        const isOffer = notif.type === "offer";
        
        return (
          <div 
            key={notif.id} 
            className={`flex items-start gap-4 rounded-xl border p-4 ${
              isOffer 
                ? 'border-orange-200 bg-orange-50' 
                : 'border-slate-200 bg-white'
            }`}
          >
            <div className={`mt-0.5 ${isOffer ? 'text-orange-600' : 'text-primary'}`}>
              <Icon size={20} />
            </div>
            <div className="flex-1 border-l-2 pl-3 border-opacity-20 border-current">
              <p className={`text-sm font-semibold ${isOffer ? 'text-orange-900' : 'text-slate-900'}`}>
                {notif.title}
              </p>
              <p className={`mt-1 text-xs ${isOffer ? 'text-orange-700/70' : 'text-slate-500'}`}>
                {notif.time}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
