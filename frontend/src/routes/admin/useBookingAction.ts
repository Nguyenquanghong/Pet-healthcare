import { useRef, useState } from "react";
import { useAppStore } from "../../store/AppStoreProvider";

// Related forms must not announce success when the server rejected a stale booking.
export function useBookingAction() {
  const { refreshData } = useAppStore();
  const pending = useRef(false);
  const [error, setError] = useState("");
  const run = async (write: () => Promise<unknown>, onSaved: () => void) => {
    if (pending.current) return;
    pending.current = true; setError("");
    let saved = false;
    try {
      await write(); saved = true; onSaved(); await refreshData();
    } catch (reason) {
      setError(saved ? "Đã lưu nhưng chưa tải lại được danh sách. Hãy tải lại trang để đối chiếu."
        : reason instanceof Error ? reason.message : "Không lưu được thao tác. Vui lòng thử lại sau khi kiểm tra trạng thái.");
    } finally { pending.current = false; }
  };
  return { run, error };
}
