import { useEffect, useRef, useState } from "react";
import { apiClient } from "../../services/apiClient";
import { usePagedList } from "../../services/usePagedList";
import type { ListPage } from "../../types/list";
import { Pagination } from "./Pagination";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Pet } from "../../types/pet";

export function PagedSelect<T extends { id: string }>({ endpoint, label, value, onChange, itemLabel, filters = {}, onSelect, emptyValue = "", emptyLabel = "Chọn", required = false, autoSelectFirst = false }: {
  endpoint: string; label: string; value: string; onChange: (value: string) => void; itemLabel: (item: T) => string;
  filters?: Record<string, string | undefined>; onSelect?: (item: T) => void; emptyValue?: string; emptyLabel?: string; required?: boolean; autoSelectFirst?: boolean;
}) {
  const [q, setQuery] = useState("");
  const list = usePagedList<T>(endpoint, { ...filters, q });
  const [selected, setSelected] = useState<T | null>(null);
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  useEffect(() => { if (autoSelectFirst && !value && list.items[0]) { setSelected(list.items[0]); selectRef.current?.(list.items[0]); changeRef.current(list.items[0].id); } }, [list.items, value, autoSelectFirst]);
  const filterKey = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  useEffect(() => {
    if (!value || value === emptyValue) { setSelected(null); return; }
    let active = true;
    void apiClient.get<ListPage<T>>(`${endpoint}?${filterKey}&id=${encodeURIComponent(value)}&pageSize=1`).then(result => {
      if (active && result.items[0]) { setSelected(result.items[0]); selectRef.current?.(result.items[0]); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [value, endpoint, filterKey, emptyValue]);
  const options = selected && !list.items.some(item => item.id === selected.id) ? [selected, ...list.items] : list.items;
  return <div className="space-y-2">
    <label className="block text-sm font-semibold">{label}
      <input aria-label={`${label} — tìm kiếm`} placeholder="Tìm tên hoặc mã..." className="mt-1 w-full rounded-lg border p-2 text-sm font-normal" value={q} onChange={event => setQuery(event.target.value)} />
      <select aria-label={label} required={required} className="mt-2 w-full rounded-lg border p-2 text-sm font-normal" value={value} onChange={event => {
        const item = options.find(option => option.id === event.target.value);
        if (item) { setSelected(item); onSelect?.(item); } else setSelected(null);
        onChange(event.target.value);
      }}><option value={emptyValue}>{emptyLabel}</option>{value && value !== emptyValue && !options.some(item => item.id === value) && <option value={value}>{value}</option>}{options.map(item => <option key={item.id} value={item.id}>{itemLabel(item)}</option>)}</select>
    </label>
    <Pagination {...list} />
  </div>;
}
export function PetLookup(props: { label: string; value: string; onChange: (value: string) => void; ownerId?: string; emptyValue?: string; emptyLabel?: string }) {
  const { rememberPet } = useAppStore();
  return <PagedSelect<Pet> {...props} autoSelectFirst={!props.emptyValue} endpoint="/pets" filters={{ ownerId: props.ownerId }} itemLabel={pet => `${pet.name} — ${pet.breed}`} onSelect={rememberPet} />;
}
