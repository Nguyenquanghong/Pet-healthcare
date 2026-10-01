import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";

export type OwnerDraft = { fullName: string; phone: string; email: string; address: string };
export const emptyOwnerDraft = (): OwnerDraft => ({ fullName: "", phone: "", email: "", address: "" });

export function OwnerDraftFields({ value, onChange }: { value: OwnerDraft; onChange: (value: OwnerDraft) => void }) {
  const set = (field: keyof OwnerDraft, next: string) => onChange({ ...value, [field]: next });
  return <div className="space-y-4">
    <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Tạo hồ sơ khách tại quầy bằng họ tên và số điện thoại. Sau đó thêm thú cưng và đặt dịch vụ. Hồ sơ này chưa cấp đăng nhập online.</p>
    <Input id="reception-owner-name" label="Họ tên khách" required autoFocus maxLength={100} autoComplete="off" value={value.fullName} onChange={e => set("fullName", e.target.value)} />
    <Input id="reception-owner-phone" label="Số điện thoại khách" required type="tel" maxLength={30} placeholder="Ví dụ: 09xxxxxxxx hoặc +84xxxxxxxxx" autoComplete="off" value={value.phone} onChange={e => set("phone", e.target.value)} />
    <Input id="reception-owner-email" label="Email khách (không bắt buộc)" type="email" maxLength={254} autoComplete="off" value={value.email} onChange={e => set("email", e.target.value)} />
    <Textarea id="reception-owner-address" label="Địa chỉ khách (không bắt buộc)" maxLength={500} rows={2} value={value.address} onChange={e => set("address", e.target.value)} />
  </div>;
}
