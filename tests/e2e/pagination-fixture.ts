// Shared controlled-API response contract; PostgreSQL tests cover the actual query implementation.
type Row = Record<string, any>;
const resources: Record<string, string> = { "/owners": "owners", "/pets": "pets", "/appointments": "appointments", "/hotel-bookings": "hotelBookings", "/medical-records": "medicalRecords", "/medical-records/images": "medicalImages", "/hotel-care-notes": "dailyCareNotes", "/notifications": "notifications", "/invoices": "invoices" };
export function pagedFixture(rawUrl: string, state: Record<string, any>) {
  const url = new URL(rawUrl), path = url.pathname.replace(/^\/api/, ""), q = url.searchParams;
  const pet = (id: string) => (state.pets ?? []).find((row: Row) => row.id === id);
  const owner = (id: string) => (state.owners ?? []).find((row: Row) => row.id === id);
  const spa = (row: Row) => ["spa_bath", "spa_grooming", "spa_combo"].includes(row.type);
  if (path === "/appointments/calendar") return Object.fromEntries((state.appointments ?? []).filter((row: Row) => row.date.startsWith(q.get("month")!) && (q.get("category") === "spa" ? spa(row) : !spa(row))).map((row: Row) => [row.date, (state.appointments ?? []).filter((item: Row) => item.date === row.date).length]));
  const key = resources[path]; if (!key) return undefined;
  let rows: Row[] = structuredClone(state[key] ?? []);
  rows = rows.filter(row => ["id", "ownerId", "petId", "species", "healthStatus", "roomType", "bookingId"].every(field => !q.get(field) || q.get(field) === "all" || row[field] === q.get(field)) && (!q.get("date") || row.date === q.get("date")));
  if (q.get("category") && path === "/appointments") rows = rows.filter(row => q.get("category") === "spa" ? spa(row) : !spa(row));
  if (q.get("q")) rows = rows.filter(row => JSON.stringify([row, pet(row.petId), owner(row.ownerId)]).toLocaleLowerCase("vi").includes(q.get("q")!.toLocaleLowerCase("vi")));
  if (q.get("mode") === "unbilled") rows = rows.filter(row => (key === "appointments" ? row.status === "completed" : ["in_stay", "checked_out"].includes(row.status)) && !(state.invoices ?? []).some((invoice: Row) => invoice.appointmentId === row.id || invoice.hotelBookingId === row.id));
  const counts: Record<string, number> = {};
  for (const row of rows) { const status = row.paymentStatus ?? row.status; if (status) counts[status] = (counts[status] ?? 0) + 1; }
  if (q.get("status") && q.get("status") !== "all") rows = rows.filter(row => (row.paymentStatus ?? row.status) === q.get("status"));
  if (q.get("statusGroup") && q.get("statusGroup") !== "all") rows = rows.filter(row => q.get("statusGroup") === "completed" ? row.status === "completed" : q.get("statusGroup") === "cancelled" ? ["cancelled", "no_show"].includes(row.status) : ["pending", "confirmed", "checked_in", "in_progress"].includes(row.status));
  const rank = (row: Row) => ["cancelled", "rejected", "no_show"].includes(row.status) ? 2 : ["completed", "checked_out"].includes(row.status) ? 1 : 0;
  rows.sort((a,b) => rank(a)-rank(b));
  const page = Number(q.get("page") ?? 1), pageSize = Number(q.get("pageSize") ?? 20), total = rows.length;
  return { items: rows.slice((page-1)*pageSize, page*pageSize), pagination: { page, pageSize, total, totalPages: Math.ceil(total/pageSize) }, counts,
    related: { owners: state.owners ?? [], pets: state.pets ?? [], appointments: state.appointments ?? [], hotelBookings: [], medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [], invoices: state.invoices ?? [] } };
}
