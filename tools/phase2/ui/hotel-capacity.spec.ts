import { expect, test, type BrowserContext } from '@playwright/test';

// AQ-10: the admin hotel page edits rooms per type; staff only read them, and the
// server's 409 (below what is already booked) is shown, not swallowed.
async function fixture(context: BrowserContext, role: 'admin' | 'staff') {
  const capacities = [{ roomType: 'standard', capacity: 10 }, { roomType: 'deluxe', capacity: 5 }, { roomType: 'vip', capacity: 2 }]
    .map(row => ({ ...row, updatedAt: '2026-10-23T00:00:00.000Z' }));
  const state = { reads: 0, puts: [] as Array<{ roomType: string; capacity: number }> };
  const empty = { items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 }, counts: {},
    related: { owners: [], pets: [], appointments: [], hotelBookings: [], medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [], invoices: [] } };
  const permissions = role === 'admin' ? ['booking.manage', 'hotel.capacity.manage'] : ['booking.manage'];
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/me') return json({ user: { id: role + '-1', role, fullName: 'Capacity ' + role, phone: '', permissions } });
    if (path === '/api/notifications/unread-count') return json({ unread: 0, asOf: new Date().toISOString() });
    if (path === '/api/hotel-bookings' || path === '/api/invoices') return json(empty);
    if (path === '/api/hotel-capacity') { state.reads++; return json({ items: capacities }); }
    const put = /^\/api\/hotel-capacity\/(\w+)$/.exec(path);
    if (put && request.method() === 'PUT') {
      const { capacity } = request.postDataJSON() as { capacity: number };
      state.puts.push({ roomType: put[1], capacity });
      if (capacity === 0) return json({ error: 'Không thể giảm sức chứa xuống dưới số phòng đã đặt của các đêm tới.' }, 409);
      const row = capacities.find(item => item.roomType === put[1])!; row.capacity = capacity;
      return json({ capacity: row });
    }
    return json({ error: `Unexpected ${request.method()} ${path}` }, 501);
  });
  const page = await context.newPage();
  await page.addInitScript(token => sessionStorage.setItem('nipopeto_access_token', token), role + '-capacity-token');
  await page.goto('/admin/hotel-bookings');
  await expect(page.getByRole('heading', { name: 'Quản lý Hotel Bookings' })).toBeVisible();
  return { page, state, panel: page.locator('details', { hasText: 'Sức chứa phòng theo loại' }) };
}

test('admin opens the capacity panel on demand, saves a change and sees the 409 refusal', async ({ context }) => {
  const { page, state, panel } = await fixture(context, 'admin');
  expect(state.reads).toBe(0);
  await page.getByText('Sức chứa phòng theo loại (mỗi đêm)').click();
  const vip = page.getByLabel('Sức chứa VIP');
  await expect(vip).toHaveValue('2');
  expect(state.reads).toBe(1);
  await vip.fill('3');
  await panel.getByRole('button', { name: 'Lưu', exact: true }).nth(2).click();
  await expect(page.getByText('Đã lưu: VIP còn 3 phòng mỗi đêm, áp dụng từ hôm nay.')).toBeVisible();
  await vip.fill('0');
  await panel.getByRole('button', { name: 'Lưu', exact: true }).nth(2).click();
  await expect(page.getByRole('alert').filter({ hasText: 'dưới số phòng đã đặt' })).toBeVisible();
  expect(state.puts).toEqual([{ roomType: 'vip', capacity: 3 }, { roomType: 'vip', capacity: 0 }]);
});

test('staff see capacities read-only and cannot save', async ({ context }) => {
  const { page, state, panel } = await fixture(context, 'staff');
  await page.getByText('Sức chứa phòng theo loại (mỗi đêm)').click();
  await expect(page.getByLabel('Sức chứa Standard')).toHaveValue('10');
  await expect(page.getByLabel('Sức chứa Standard')).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Lưu', exact: true })).toHaveCount(0);
  expect(state.puts).toEqual([]);
});
