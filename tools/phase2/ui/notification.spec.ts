import { expect, test, type Page } from '@playwright/test';

// UI state/request tests only. PostgreSQL/HTTP runtime suite verifies actual
// dedup, scopes, transactions and failures. Every API is intercepted here.
async function fixture(page: Page, role: 'admin' | 'owner' = 'admin') {
  const owner = { id: 'p2-ui-owner', fullName: 'Fixture owner', phone: '000-fixture', petIds: [] };
  const state = { currentOwnerId: role === 'owner' ? owner.id : '', owners: [owner], pets: [], appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [],
    summary: { totals: {}, species: {}, appointmentStatus: {}, hotelStatus: {}, notificationCategory: {}, unread: 0, todayAppointments: 0 } };
  const control = { failUnread: false, failRefresh: false, loseResponse: false, holdSend: false, release: () => {},
    sends: [] as { key: string | undefined; body: Record<string, string> }[] };
  await page.addInitScript(() => sessionStorage.setItem('nipopeto_access_token', 'p2-ui-fixture-token'));
  // Never reach an existing demo API or any external account/service.
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { 'access-control-allow-origin': '*' } });
    if (!url.pathname.startsWith('/api/')) {
      if (url.origin === 'http://127.0.0.1:5187') return route.continue();
      return route.abort();
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (url.pathname === '/api/auth/me') return json({ user: { ...owner, role } });
    if (url.pathname === '/api/bootstrap') return control.failRefresh ? json({ error: 'Fixture refresh unavailable' }, 503) : json(state);
    if (url.pathname === '/api/notifications/unread-count') return control.failUnread || control.failRefresh ? json({ error: 'Fixture unread unavailable' }, 503) : json({ unread: 3, asOf: new Date().toISOString() });
    if (req.method() === 'GET' && ['/api/notifications','/api/owners'].includes(url.pathname)) return control.failRefresh&&url.pathname==='/api/notifications'?json({error:'Fixture refresh unavailable'},503):json({ items: url.pathname.endsWith('/owners') ? [owner] : [], pagination: { page: 1, pageSize: 20, total: url.pathname.endsWith('/owners') ? 1 : 0, totalPages: 1 }, counts: {}, related: {} });
    if (url.pathname === '/api/notifications/send' && req.method() === 'POST') {
      control.sends.push({ key: req.headers()['idempotency-key'], body: req.postDataJSON() });
      if (control.holdSend) await new Promise<void>(done => { control.release = done; });
      if (control.loseResponse) { control.loseResponse = false; return route.abort('failed'); }
      return json({ notification: { id: 'p2-ui-notification' } }, 201);
    }
    return json({ error: 'Unexpected fixture route' }, 501);
  });
  return control;
}
async function compose(page: Page) {
  await page.goto('/admin/notifications');
  await page.getByRole('button', { name: 'Gửi thông báo cho Chủ nuôi', exact: true }).click();
  await page.getByLabel('Người nhận *', { exact: true }).selectOption('p2-ui-owner');
  await page.getByRole('button', { name: 'Tùy chỉnh', exact: true }).click();
  await page.getByPlaceholder('Nhập tiêu đề thông báo...').fill('Fixture title');
  await page.getByPlaceholder('Nhập nội dung gửi chủ nuôi...').fill('Fixture content');
}
test('lost send response reuses request key; changed intent gets a new key; in-flight cannot double-submit', async ({ page }) => {
  const api = await fixture(page); await compose(page);
  api.loseResponse = true;
  await page.getByRole('button', { name: 'Gửi thông báo ngay', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Gửi thông báo ngay', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Đã gửi thông báo cho chủ nuôi thành công');
  expect(api.sends).toHaveLength(2); expect(api.sends[0].key).toMatch(/^[0-9a-f-]{36}$/); expect(api.sends[1]).toEqual(api.sends[0]);
  await page.getByPlaceholder('Nhập tiêu đề thông báo...').fill('New intent');
  await page.getByPlaceholder('Nhập nội dung gửi chủ nuôi...').fill('New content');
  api.holdSend = true;
  await page.getByRole('button', { name: 'Gửi thông báo ngay', exact: true }).click();
  await expect.poll(() => api.sends.length).toBe(3);
  await expect(page.getByRole('button', { name: 'Đang gửi thông báo...', exact: true })).toBeDisabled();
  expect(api.sends[2].key).not.toBe(api.sends[0].key);
  api.release(); await expect(page.getByRole('status')).toContainText('Đã gửi thông báo cho chủ nuôi thành công');
});
test('committed send with refresh failure displays success and retains no retry action', async ({ page }) => {
  const api = await fixture(page); await compose(page); api.failRefresh = true;
  await page.getByRole('button', { name: 'Gửi thông báo ngay', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã gửi thông báo nhưng chưa tải lại' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gửi thông báo ngay', exact: true })).toBeDisabled();
  expect(api.sends).toHaveLength(1);
});
test('owner count comes from Notification; unavailable count never displays all-read', async ({ page }) => {
  const api = await fixture(page, 'owner');
  await page.goto('/owner/notifications');
  await expect(page.getByText('Bạn có 3 thông báo chưa đọc', { exact: true })).toBeVisible();
  api.failUnread = true; await page.reload();
  await expect(page.getByText('Chưa tải được số thông báo chưa đọc.', { exact: true })).toBeVisible();
  await expect(page.getByText('Đã đọc tất cả thông báo', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Đánh dấu tất cả đã đọc', exact: true })).toHaveCount(0);
});
