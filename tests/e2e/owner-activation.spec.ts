import { pagedFixture } from "./pagination-fixture";
import { expect, test, type Page } from "@playwright/test";

const token = "A".repeat(43);
async function mockApi(page: Page) {
  const controls = { issueCalls: [] as Record<string, unknown>[], consumeCalls: [] as Record<string, unknown>[], requests: [] as string[],
    invalid: false, failInspect: false, loseConsume: false, holdIssue: false, release: () => {} };
  await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "existing-staff-session"));
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    controls.requests.push(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*",
    } });
    if (path.endsWith("/auth/me")) return json({ user: { role: "staff" } });
    const state = { currentOwnerId: "", owners: [
      { id: "counter-owner", fullName: "Khách tại quầy", phone: "0912345678", petIds: [], loginEnabled: false },
      { id: "active-owner", fullName: "Khách online", phone: "0900000002", email: "active@example.test", petIds: [], loginEnabled: true },
    ], pets: [], appointments: [], hotelBookings: [], medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [] };
    if (path.endsWith("/bootstrap")) return json(state);
    if (req.method() === "GET") { const paged = pagedFixture(req.url(), state); if (paged) return json(paged); }
    if (path.endsWith("/owners/counter-owner/activation")) {
      controls.issueCalls.push(req.postDataJSON());
      if (controls.holdIssue) await new Promise<void>(resolve => { controls.release = resolve; });
      return json({ activation: { token: controls.issueCalls.length === 1 ? token : "B".repeat(43), email: req.postDataJSON().email.trim().toLowerCase(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } }, 201);
    }
    if (path.endsWith("/auth/owner/activation/inspect")) {
      expect(req.postDataJSON()).toEqual({ token });
      if (controls.failInspect) return json({ error: "Không kết nối được" }, 503);
      if (controls.invalid) return json({ error: "Liên kết kích hoạt không hợp lệ, đã hết hạn hoặc đã được sử dụng. Liên hệ cửa hàng để được cấp lại." }, 422);
      return json({ email: "customer@example.test", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    }
    if (path.endsWith("/auth/owner/activation")) {
      controls.consumeCalls.push(req.postDataJSON());
      if (controls.loseConsume) return route.abort("failed");
      return json({ email: "customer@example.test", message: "Đã kích hoạt tài khoản." });
    }
    return json({ error: "Unexpected call" }, 501);
  });
  return controls;
}

test("staff verifies the customer before issue, busy form is guarded, and reissue needs new confirmation", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/owners");
  const row = page.locator("tbody tr").filter({ hasText: "Khách tại quầy" });
  await row.getByRole("button", { name: "Kích hoạt tài khoản" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("0912345678");
  const issue = dialog.getByRole("button", { name: "Cấp liên kết kích hoạt", exact: true });
  await expect(issue).toBeDisabled();
  await dialog.getByLabel("Email đăng nhập của khách").fill("customer@example.test");
  await dialog.getByRole("checkbox").check();
  api.holdIssue = true;
  await issue.click();
  await expect.poll(() => api.issueCalls.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Đang cấp..." })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  api.release(); api.holdIssue = false;
  await expect(dialog.getByLabel("Liên kết kích hoạt")).toHaveValue(new RegExp(`/activate-account#token=${token}$`));
  await expect(dialog).toContainText("30 phút");
  expect(api.issueCalls[0]).toEqual({ email: "customer@example.test", customerVerified: true });
  await dialog.getByRole("button", { name: "Cấp lại liên kết", exact: true }).click();
  await expect(dialog).toContainText("thu hồi liên kết cũ");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Xác nhận cấp lại" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Xác nhận cấp lại" }).click();
  await expect(dialog.getByLabel("Liên kết kích hoạt")).toHaveValue(new RegExp(`token=${"B".repeat(43)}$`));
  expect(api.issueCalls).toHaveLength(2);
});

test("active customers have no activation/reset action; search finds counter profiles without pets", async ({ page }) => {
  await mockApi(page);
  await page.goto("/admin/owners");
  const active = page.locator("tbody tr").filter({ hasText: "Khách online" });
  await expect(active).toContainText("Đã kích hoạt");
  await expect(active.getByRole("button")).toHaveCount(0);
  await page.getByLabel("Tìm khách hàng").fill("0912345678");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("counter-owner");
});

test("customer sets their own password using a fragment link, keeps session, and logs in separately", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto(`/activate-account#token=${token}`);
  await expect(page.getByText("customer@example.test", { exact: true })).toBeVisible();
  await page.getByLabel("Mật khẩu mới", { exact: true }).fill("CustomerSecure123");
  await page.getByLabel("Xác nhận mật khẩu", { exact: true }).fill("DifferentPassword123");
  await page.getByRole("button", { name: "Đặt mật khẩu và kích hoạt" }).click();
  await expect(page.getByRole("alert")).toContainText("chưa khớp");
  expect(api.consumeCalls).toHaveLength(0);
  await page.getByLabel("Xác nhận mật khẩu", { exact: true }).fill("CustomerSecure123");
  await page.getByRole("button", { name: "Đặt mật khẩu và kích hoạt" }).click();
  await expect(page.getByRole("status")).toContainText("Đã kích hoạt tài khoản");
  await expect(page).toHaveURL(/\/activate-account$/);
  await expect(page.getByRole("link", { name: "Đăng nhập", exact: true })).toHaveAttribute("href", "/login");
  await expect(page.getByLabel("Mật khẩu mới", { exact: true })).toHaveCount(0);
  expect(api.consumeCalls).toEqual([{ token, password: "CustomerSecure123", confirmPassword: "CustomerSecure123" }]);
  expect(api.requests.every(url => !url.includes(token))).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBe("existing-staff-session");
});

test("expired/revoked/used links show recovery guidance and never show a password form", async ({ page }) => {
  const api = await mockApi(page); api.invalid = true;
  await page.goto(`/activate-account#token=${token}`);
  await expect(page.getByRole("alert")).toContainText("đã hết hạn");
  await expect(page.getByLabel("Mật khẩu mới", { exact: true })).toHaveCount(0);
  expect(api.consumeCalls).toHaveLength(0);
  await page.goto("/activate-account#token=invalid");
  await expect(page.getByRole("alert")).toContainText("không hợp lệ");
});

test("inspection can recover from a temporary connection failure", async ({ page }) => {
  const api = await mockApi(page); api.failInspect = true;
  await page.goto(`/activate-account#token=${token}`);
  await expect(page.getByRole("alert")).toContainText("Không kết nối");
  api.failInspect = false;
  await page.getByRole("button", { name: "Thử kiểm tra lại" }).click();
  await expect(page.getByLabel("Mật khẩu mới", { exact: true })).toBeVisible();
  expect(api.consumeCalls).toHaveLength(0);
});

test("a lost activation response gives login recovery guidance and does not create another profile", async ({ page }) => {
  const api = await mockApi(page); api.loseConsume = true;
  await page.goto(`/activate-account#token=${token}`);
  await page.getByLabel("Mật khẩu mới", { exact: true }).fill("CustomerSecure123");
  await page.getByLabel("Xác nhận mật khẩu", { exact: true }).fill("CustomerSecure123");
  await page.getByRole("button", { name: "Đặt mật khẩu và kích hoạt" }).click();
  await expect(page.getByRole("alert")).toContainText("hãy thử đăng nhập");
  expect(api.consumeCalls).toHaveLength(1);
  expect(api.requests.some(url => new URL(url).pathname === "/api/owners")).toBe(false);
});
