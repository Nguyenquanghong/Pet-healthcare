import { expect, test, type BrowserContext, type Page } from '@playwright/test';

type Booking = Record<string, unknown>;

async function fixture(context: BrowserContext) {
  const owner = { id: 'refresh-owner', role: 'owner', fullName: 'Refresh Owner', phone: '0900000001', petIds: ['refresh-pet'] };
  const pet = { id: 'refresh-pet', ownerId: owner.id, name: 'Milo Refresh', species: 'dog', breed: 'Poodle', gender: 'male', ageLabel: '', healthStatus: 'healthy', allergies: [] };
  const state = { appointments: [] as Booking[], hotels: [] as Booking[], adminReads: 0 };
  const page = (items: Booking[]) => ({ items, pagination: { page: 1, pageSize: 20, total: items.length, totalPages: items.length ? 1 : 0 },
    counts: { pending: items.length }, related: { owners: [owner], pets: [pet], appointments: [], hotelBookings: [], medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [], invoices: [] } });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const isOwner = request.headers().authorization === 'Bearer owner-refresh-token';
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/me') return json({ user: isOwner ? owner : { ...owner, id: 'refresh-admin', role: 'admin' } });
    if (path === '/api/notifications/unread-count') return json({ unread: 0, asOf: new Date().toISOString() });
    if (path === '/api/pets') return json(page([pet]));
    if (path === '/api/appointments/calendar') return json({});
    if (path === '/api/dashboard/core') return json({ asOf: new Date().toISOString(), owners: [owner], pets: [pet], hotelBookings: state.hotels,
      summary: { totals: { pets: 1, owners: 1, hotelBookings: state.hotels.length }, species: { dog: 1 }, hotelStatus: { pending: state.hotels.length } } });
    if (path === '/api/dashboard/clinic') return json({ asOf: new Date().toISOString(), owners: [owner], pets: [pet], appointments: state.appointments,
      medicalRecords: [], summary: { totals: { appointments: state.appointments.length }, appointmentStatus: { pending: state.appointments.length }, todayAppointments: 0 } });
    if (path === '/api/appointments' && request.method() === 'GET') {
      if (!isOwner) state.adminReads++;
      return json(page(isOwner ? state.appointments.filter(item => item.ownerId === owner.id) : state.appointments));
    }
    if (path === '/api/hotel-bookings' && request.method() === 'GET') {
      if (!isOwner) state.adminReads++;
      return json(page(isOwner ? state.hotels.filter(item => item.ownerId === owner.id) : state.hotels));
    }
    if (path === '/api/appointments' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const appointment = { id: 'refresh-appointment', ...body, ownerId: owner.id, status: 'pending', statusRevision: 0,
        createdBy: 'owner', clinicName: 'Nippon Pet Care', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.appointments.unshift(appointment); return json({ appointment }, 201);
    }
    if (path === '/api/hotel-bookings' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const booking = { id: 'refresh-hotel', ...body, ownerId: owner.id, status: 'pending', statusRevision: 0,
        nights: 1, totalAmount: 100000, dailyCareNoteIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.hotels.unshift(booking); return json({ booking }, 201);
    }
    if (path === '/api/hotel-bookings/refresh-hotel') return json({ booking: state.hotels[0], related: { pets: [pet], owners: [owner] } });
    return json({ error: `Unexpected ${request.method()} ${path}` }, 501);
  });
  const open = async (role: 'owner' | 'admin', path: string): Promise<Page> => {
    const tab = await context.newPage();
    await tab.addInitScript(token => sessionStorage.setItem('nipopeto_access_token', token), `${role}-refresh-token`);
    await tab.goto(path);
    return tab;
  };
  return { state, open };
}

test('owner appointment appears in already-open Admin list and dashboard', async ({ context }) => {
  const api = await fixture(context);
  const list = await api.open('admin', '/admin/appointments');
  const dashboard = await api.open('admin', '/admin/dashboard');
  await expect(list.getByRole('heading', { name: 'Quản lý lịch hẹn' })).toBeVisible();
  await expect(dashboard.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const owner = await api.open('owner', '/owner/appointments');
  const submit = owner.getByRole('button', { name: 'Gửi yêu cầu đặt lịch', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(owner.getByText('Đã gửi yêu cầu đặt lịch!', { exact: false })).toBeVisible();
  await expect(list.locator('tbody tr').filter({ hasText: 'Milo Refresh' })).toBeVisible();
  await expect(dashboard.getByRole('button', { name: /Xem và xác nhận lịch Milo Refresh/ })).toBeVisible();
});

test('owner hotel booking appears in already-open Admin list and dashboard', async ({ context }) => {
  const api = await fixture(context);
  const list = await api.open('admin', '/admin/hotel-bookings');
  const dashboard = await api.open('admin', '/admin/dashboard');
  await expect(list.getByRole('heading', { name: 'Quản lý Hotel Bookings' })).toBeVisible();
  await expect(dashboard.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const owner = await api.open('owner', '/owner/hotel-booking');
  const submit = owner.getByRole('button', { name: 'Xác nhận đặt phòng', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(list.getByTestId('hotel-booking-refresh-hotel')).toBeVisible();
  await expect(dashboard.getByRole('button', { name: /Xem và xác nhận hotel Milo Refresh/ })).toBeVisible();
});

test('Admin list notices a booking written from another browser without a tab message', async ({ context }) => {
  const api = await fixture(context);
  const admin = await api.open('admin', '/admin/appointments');
  await expect.poll(() => api.state.adminReads).toBeGreaterThan(0);
  api.state.appointments.push({ id: 'external-appointment', petId: 'refresh-pet', ownerId: 'refresh-owner',
    type: 'general_checkup', serviceName: 'External booking', clinicName: 'Nippon Pet Care', date: '2030-01-01', time: '09:00',
    status: 'pending', statusRevision: 0, createdBy: 'owner', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await expect(admin.locator('tbody tr').filter({ hasText: 'External booking' })).toBeVisible({ timeout: 8000 });
});
