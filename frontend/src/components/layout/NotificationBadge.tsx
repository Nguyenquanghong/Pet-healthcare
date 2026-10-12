import { useNotificationCount } from '../../store/NotificationCountContext';
export function NotificationBadge({ className }: { className: string }) {
  const count = useNotificationCount(), n = count.data?.unread;
  if (n === 0 && !count.error) return null;
  return <span className={className} aria-label={count.error ? 'Chưa cập nhật được thông báo' : n === undefined ? 'Đang tải thông báo' : `${n} thông báo chưa đọc`}
    title={count.error ? `Thông báo chưa cập nhật${count.data && count.asOf ? '; số chưa đọc được tải lúc '+new Date(count.asOf).toLocaleTimeString('vi-VN', {timeZone:'Asia/Ho_Chi_Minh'}) : ''}. Mở hộp thư để thử lại.` : undefined}>{count.error ? n && n > 0 ? `${n > 9 ? '9+' : n}!` : '?' : n === undefined ? '…' : n > 9 ? '9+' : n}</span>;
}
