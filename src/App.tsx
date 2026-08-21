import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Bell, CalendarDays, FileText, Hotel, LayoutDashboard, PawPrint, Search, Settings, Stethoscope } from "lucide-react";
import { formatCurrency } from "./utils/formatCurrency";

const pets = [
  { id: "p1", name: "Mochi", breed: "Shiba Inu", age: "2 tuổi", status: "Khỏe mạnh", owner: "Nguyễn Văn A" },
  { id: "p2", name: "Sashimi", breed: "Scottish Fold", age: "1 tuổi", status: "Cần tiêm phòng", owner: "Trần Thị B" },
  { id: "p3", name: "Maximus", breed: "Golden Retriever", age: "4 tuổi", status: "Ổn định", owner: "Lê Minh C" },
];

const appointments = [
  { time: "09:00", pet: "Mochi", service: "Khám tổng quát", doctor: "Bs. Mai Nguyễn", status: "Đã xác nhận" },
  { time: "10:30", pet: "Sashimi", service: "Tiêm phòng", doctor: "Dr. Kenji Sato", status: "Chờ xác nhận" },
  { time: "14:00", pet: "Maximus", service: "Dental Cleaning", doctor: "Bs. Trần Anh", status: "Đã check-in" },
];

const records = [
  { date: "28/10/2026", pet: "Mochi", title: "Annual Checkup & Vaccination", note: "Sức khỏe ổn định, nhắc lịch tái khám sau 6 tháng." },
  { date: "14/10/2026", pet: "Maximus", title: "Dental Cleaning", note: "Làm sạch răng, kê gel chăm sóc nướu." },
  { date: "02/10/2026", pet: "Sashimi", title: "Dermatology Consult", note: "Theo dõi dị ứng thức ăn, tái khám nếu ngứa tăng." },
];

const notifications = [
  "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.",
  "Sashimi cần tiêm phòng nhắc lại trong tuần này.",
  "Ưu đãi 20% dịch vụ Grooming & Spa cho khách hàng thành viên.",
];

const bookings = [
  { pet: "Yuki", owner: "Nguyễn Văn A", dates: "10/11 - 13/11", room: "Deluxe Suite", total: 20100, status: "Chờ xác nhận" },
  { pet: "Mochi", owner: "Nguyễn Văn A", dates: "18/11 - 20/11", room: "Standard Cabin", total: 7600, status: "Đã xác nhận" },
];

const ownerNav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/pets", label: "Pet Profiles", icon: PawPrint },
  { to: "/medical-records", label: "Medical Records", icon: FileText },
  { to: "/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/hotel-booking", label: "Hotel Booking", icon: Hotel },
  { to: "/notifications", label: "Notifications", icon: Bell },
];

const adminNav = [
  { to: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/admin/pets", label: "Pets", icon: PawPrint },
  { to: "/admin/medical-records", label: "Medical Records", icon: FileText },
  { to: "/admin/hotel-bookings", label: "Hotel Bookings", icon: Hotel },
  { to: "/admin/notifications", label: "Notifications", icon: Bell },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];

type Children = { children: React.ReactNode };

function StatusBadge({ children }: { children: string }) {
  const tone = children.includes("Chờ") || children.includes("Cần") ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700";
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{children}</span>;
}

function Card({ title, children, className = "" }: Children & { title?: string; className?: string }) {
  return <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-soft ${className}`}>{title && <h2 className="mb-4 text-lg font-bold text-slate-900">{title}</h2>}{children}</section>;
}

function Sidebar({ type }: { type: "owner" | "admin" }) {
  const nav = type === "owner" ? ownerNav : adminNav;
  return <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col bg-primary p-5 text-white lg:flex"><div className="mb-8"><div className="text-xl font-extrabold tracking-wide">NIPPON PET CARE</div><div className="text-xs text-cyan-100">Công Nghệ Nhật Bản</div><div className="mt-3 rounded-full bg-white/10 px-3 py-1 text-xs">{type === "owner" ? "Owner Portal" : "Hospital Admin"}</div></div><nav className="space-y-2">{nav.map((item) => { const Icon = item.icon; return <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${isActive ? "bg-aqua text-primary" : "text-white/80 hover:bg-white/10 hover:text-white"}`}><Icon size={18} />{item.label}</NavLink>; })}</nav><NavLink to={type === "owner" ? "/admin/dashboard" : "/"} className="mt-auto rounded-xl bg-white/10 px-4 py-3 text-center text-sm font-semibold hover:bg-white/20">{type === "owner" ? "Sang Admin" : "Sang Owner"}</NavLink></aside>;
}

function Layout({ type, title, children }: Children & { type: "owner" | "admin"; title: string }) {
  return <div className="min-h-screen bg-canvas text-ink"><Sidebar type={type} /><main className="lg:ml-64"><header className="sticky top-0 z-10 flex flex-col gap-4 border-b border-slate-200 bg-canvas/90 px-5 py-5 backdrop-blur md:flex-row md:items-center md:justify-between lg:px-8"><div><p className="text-sm font-semibold text-primary">{type === "owner" ? "Chủ thú cưng" : "Bệnh viện Thú y Mỹ Đình"}</p><h1 className="text-2xl font-extrabold text-slate-950">{title}</h1></div><div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-500 shadow-sm"><Search size={18} /><span className="text-sm">Search pet, owner, appointment...</span></div></header><div className="p-5 lg:p-8">{children}</div></main></div>;
}

function PetCard({ pet }: { pet: (typeof pets)[number] }) { return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-aqua text-2xl">🐾</div><h3 className="font-bold">{pet.name}</h3><p className="text-sm text-slate-500">{pet.breed} · {pet.age}</p><div className="mt-3"><StatusBadge>{pet.status}</StatusBadge></div></div>; }
function AppointmentList() { return <div className="space-y-3">{appointments.map((a) => <div key={`${a.time}-${a.pet}`} className="flex items-center justify-between rounded-xl bg-slate-50 p-3"><div><p className="font-bold">{a.time} · {a.pet}</p><p className="text-sm text-slate-500">{a.service} · {a.doctor}</p></div><StatusBadge>{a.status}</StatusBadge></div>)}</div>; }
function NotificationList() { return <div className="space-y-3">{notifications.map((n) => <div key={n} className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">{n}</div>)}</div>; }
function RecordList() { return <div className="space-y-3">{records.map((r) => <div key={r.title} className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold text-primary">{r.date} · {r.pet}</p><h3 className="font-bold">{r.title}</h3><p className="text-sm text-slate-500">{r.note}</p></div>)}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <Card><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-black text-primary">{value}</p></Card>; }
function Field({ label, value }: { label: string; value: string }) { return <label className="block"><span className="text-sm font-bold text-slate-600">{label}</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" defaultValue={value} /></label>; }
function SummaryRow({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) { return <div className={`flex justify-between py-2 ${bold ? "text-xl font-black" : "text-sm"}`}><span>{label}</span><span>{value}</span></div>; }

function DashboardPage() { return <Layout type="owner" title="Tổng quan"><div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]"><Card><p className="text-sm text-slate-500">Xin chào, Nguyễn Văn A</p><h2 className="mt-2 text-3xl font-black">Hôm nay thú cưng của bạn thế nào?</h2><div className="mt-6 grid gap-4 md:grid-cols-3">{pets.map((pet) => <PetCard key={pet.id} pet={pet} />)}</div></Card><Card title="Lịch trình sắp tới"><AppointmentList /></Card><Card title="Thông báo & ưu đãi"><NotificationList /></Card><Card title="Bệnh viện gần bạn"><div className="h-48 rounded-2xl bg-gradient-to-br from-cyan-100 via-blue-100 to-slate-200 p-5"><Stethoscope className="text-primary" /><p className="mt-12 font-bold">Bệnh viện Thú y Mỹ Đình</p><p className="text-sm text-slate-600">Đang mở cửa · 2.4 km</p></div></Card></div></Layout>; }
function PetsPage() { return <Layout type="owner" title="Hồ sơ thú cưng thông minh"><div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]"><Card><div className="grid gap-6 md:grid-cols-[180px_1fr]"><div className="grid h-44 place-items-center rounded-3xl bg-gradient-to-br from-amber-100 to-cyan-100 text-6xl">🐕</div><div><p className="text-sm text-slate-500">Microchip ID: JP-2026-MAX-8842</p><h2 className="mt-2 text-4xl font-black">Maximus</h2><p className="text-slate-600">Golden Retriever · Male · 4 Years</p><div className="mt-5 flex flex-wrap gap-2"><StatusBadge>Ổn định</StatusBadge><StatusBadge>Đã triệt sản</StatusBadge></div></div></div></Card><Card title="Smart QR Token"><div className="mx-auto grid h-40 w-40 place-items-center rounded-2xl border-8 border-slate-900 bg-white text-4xl">QR</div><p className="mt-4 text-center text-sm text-slate-500">Public mode cho thông tin khẩn cấp.</p></Card><Card title="Digital Health Record"><RecordList /></Card><Card title="Cloud Imaging"><div className="grid grid-cols-2 gap-3"><div className="h-28 rounded-xl bg-slate-100" /><div className="h-28 rounded-xl bg-slate-100" /></div></Card></div></Layout>; }
function MedicalRecordsPage() { return <Layout type="owner" title="Hồ sơ y tế chi tiết"><div className="grid gap-6 xl:grid-cols-[1.4fr_0.8fr]"><Card title="Clinical Timeline"><RecordList /></Card><div className="grid gap-4"><Metric label="Weight" value="24.5 kg" /><Metric label="Temp" value="38.2°C" /><Metric label="Heart Rate" value="92 bpm" /></div></div></Layout>; }
function AppointmentsPage() { return <Layout type="owner" title="Quản lý lịch khám"><div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]"><Card title="October 2026"><div className="grid grid-cols-7 gap-2 text-center text-sm">{Array.from({ length: 35 }, (_, i) => <div key={i} className={`rounded-xl p-3 ${[8, 15, 22].includes(i) ? "bg-aqua font-bold text-primary" : "bg-slate-50"}`}>{i + 1}</div>)}</div></Card><Card title="Today's Schedule"><AppointmentList /></Card></div></Layout>; }
function HotelBookingPage() { const nights = 3; const total = 5500 * nights + 1200 * nights; return <Layout type="owner" title="Đặt chỗ khách sạn thú cưng"><div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]"><Card title="Booking Form"><div className="grid gap-4 md:grid-cols-2"><Field label="Check-in" value="2026-11-10" /><Field label="Check-out" value="2026-11-13" /><Field label="Pet" value="Yuki - Shiba Inu" /><Field label="Room" value="Deluxe Suite" /></div></Card><Card title="Booking Summary"><SummaryRow label="Guest" value="Yuki" /><SummaryRow label="Duration" value="3 nights" /><SummaryRow label="Room" value={formatCurrency(16500)} /><SummaryRow label="Special Diet" value={formatCurrency(3600)} /><div className="mt-4 border-t pt-4"><SummaryRow label="Total" value={formatCurrency(total)} bold /></div><button className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-bold text-white">Confirm Booking</button></Card></div></Layout>; }
function NotificationsPage() { return <Layout type="owner" title="Thông báo"><Card><NotificationList /></Card></Layout>; }

function Table({ type }: { type: "appointments" | "pets" | "bookings" }) { const headers = type === "appointments" ? ["Time", "Pet", "Service", "Doctor", "Status"] : type === "pets" ? ["Pet", "Breed", "Age", "Owner", "Status"] : ["Pet", "Owner", "Dates", "Room", "Total", "Status"]; return <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b">{headers.map((h) => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{type === "appointments" && appointments.map((a) => <tr key={a.time} className="border-b"><td className="p-3 font-bold">{a.time}</td><td>{a.pet}</td><td>{a.service}</td><td>{a.doctor}</td><td><StatusBadge>{a.status}</StatusBadge></td></tr>)}{type === "pets" && pets.map((p) => <tr key={p.id} className="border-b"><td className="p-3 font-bold">{p.name}</td><td>{p.breed}</td><td>{p.age}</td><td>{p.owner}</td><td><StatusBadge>{p.status}</StatusBadge></td></tr>)}{type === "bookings" && bookings.map((b) => <tr key={`${b.pet}-${b.dates}`} className="border-b"><td className="p-3 font-bold">{b.pet}</td><td>{b.owner}</td><td>{b.dates}</td><td>{b.room}</td><td>{formatCurrency(b.total)}</td><td><StatusBadge>{b.status}</StatusBadge></td></tr>)}</tbody></table></div>; }
function AdminDashboardPage() { return <Layout type="admin" title="Admin Dashboard"><div className="grid gap-5 md:grid-cols-4"><Metric label="Today's Appointments" value="12" /><Metric label="Pending" value="4" /><Metric label="Hotel Guests" value="6" /><Metric label="Unread" value="8" /></div><div className="mt-6 grid gap-6 xl:grid-cols-2"><Card title="Today's Appointments"><AppointmentList /></Card><Card title="Pending Hotel Bookings"><Table type="bookings" /></Card></div></Layout>; }
function AdminAppointmentsPage() { return <Layout type="admin" title="Quản lý lịch khám"><Card><Table type="appointments" /></Card></Layout>; }
function AdminPetsPage() { return <Layout type="admin" title="Quản lý thú cưng"><Card><Table type="pets" /></Card></Layout>; }
function AdminMedicalRecordsPage() { return <Layout type="admin" title="Quản lý hồ sơ y tế"><Card><RecordList /></Card></Layout>; }
function AdminHotelBookingsPage() { return <Layout type="admin" title="Quản lý Hotel Booking"><Card><Table type="bookings" /></Card></Layout>; }
function AdminNotificationsPage() { return <Layout type="admin" title="Gửi thông báo"><Card title="Notification Composer"><textarea className="min-h-32 w-full rounded-xl border border-slate-200 p-4" defaultValue="Nhắc lịch khám: Mochi có lịch khám vào 09:00 ngày mai." /><button className="mt-4 rounded-xl bg-primary px-5 py-3 font-bold text-white">Send Notification</button></Card></Layout>; }

export function App() {
  return <Routes><Route path="/" element={<DashboardPage />} /><Route path="/pets" element={<PetsPage />} /><Route path="/medical-records" element={<MedicalRecordsPage />} /><Route path="/appointments" element={<AppointmentsPage />} /><Route path="/hotel-booking" element={<HotelBookingPage />} /><Route path="/notifications" element={<NotificationsPage />} /><Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} /><Route path="/admin/dashboard" element={<AdminDashboardPage />} /><Route path="/admin/appointments" element={<AdminAppointmentsPage />} /><Route path="/admin/pets" element={<AdminPetsPage />} /><Route path="/admin/medical-records" element={<AdminMedicalRecordsPage />} /><Route path="/admin/hotel-bookings" element={<AdminHotelBookingsPage />} /><Route path="/admin/notifications" element={<AdminNotificationsPage />} /><Route path="/admin/settings" element={<Layout type="admin" title="Settings"><Card>Settings placeholder</Card></Layout>} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}
