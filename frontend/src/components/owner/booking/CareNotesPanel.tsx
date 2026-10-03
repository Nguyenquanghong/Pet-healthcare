import { useState } from "react";
import type { DailyCareNote } from "../../../types/booking";
import { usePagedList } from "../../../services/usePagedList";
import { Pagination } from "../../ui/Pagination";
import { eatingStatusLabels, moodLabels } from "../../../utils/statusLabels";

export function CareNotesPanel({ bookingId }: { bookingId: string }) {
  const [open, setOpen] = useState(false);
  const list = usePagedList<DailyCareNote>("/hotel-care-notes", { bookingId }, open);
  return <details className="rounded-lg border p-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-semibold">Nhật ký chăm sóc hàng ngày</summary>
    {open && <><Pagination {...list} /><div className="space-y-3">{list.items.map(note => <article key={note.id} className="rounded bg-slate-50 p-3 text-sm">
      <p className="font-semibold">{note.date} · {eatingStatusLabels[note.eatingStatus]} · {moodLabels[note.mood]}</p><p className="mt-1 whitespace-pre-wrap">{note.note}</p>
    </article>)}{!list.loading && !list.error && !list.items.length && <p className="text-sm text-slate-500">Chưa có nhật ký chăm sóc.</p>}</div></>}
  </details>;
}
