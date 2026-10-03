import { expect, test, type Page, type Route } from "@playwright/test";
import { pagedFixture } from "./pagination-fixture";

function fixture() {
  const owner = { id: "owner", fullName: "Owner", email: "owner@example.test", phone: "0900000000", address: "Hanoi", petIds: ["pet"] };
  const pet = { id: "pet", ownerId: owner.id, name: "Mochi", species: "cat", breed: "Cat", gender: "female", ageLabel: "1", healthStatus: "healthy", allergies: [], weightKg: 6, qrEnabled: false, publicProfile: {} };
  return { currentOwnerId: owner.id, owners: [owner], pets: [pet], appointments: [], medicalRecords: [] as Record<string, any>[], medicalImages: [] as Record<string, any>[], hotelBookings: [], dailyCareNotes: [], notifications: [], invoices: [] as Record<string, any>[] };
}
type World = ReturnType<typeof fixture>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } });
async function mockApi(page: Page, state: World, role = "owner", session = true) {
  const api = { failBootstrap: false, meStatus: 200, writes: 0, failWrite: false, holdWrite: false, release: () => {},
    intercept: async (_route: Route): Promise<boolean> => false };
  if (session) await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "review-session"));
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*",
    } });
    if (await api.intercept(route)) return;
    const user = { ...state.owners[0], role };
    if (path === "/api/auth/me" && req.method() === "GET") return json(route, api.meStatus === 200 ? { user } : { error: "Cannot verify session" }, api.meStatus);
    if (path.endsWith("/login") || path.endsWith("/register")) return json(route, { token: "new-session", user });
    if (path === "/api/bootstrap") return api.failBootstrap ? json(route, { error: "Reload unavailable" }, 503) : json(route, structuredClone(state));
    if (path === "/api/payments/options") return json(route, { vnpayEnabled: false, bankTransfer: null });
    if (req.method() === "GET") {
      const result = pagedFixture(req.url(), state);
      if (result) return json(route, result);
    }
    return json(route, { error: `Unexpected ${req.method()} ${path}` }, 501);
  });
  return api;
}
function record(id: string, petId = "pet", visitDate = "2026-10-03", temperatureC = 39) {
  return { id, petId, ownerId: "owner", doctorName: "Doctor", visitDate, title: `Visit ${id}`, diagnosis: "Routine", treatment: "Follow-up", weightKg: 6, temperatureC, heartRateBpm: 100, createdAt: visitDate, updatedAt: visitDate };
}

test("latest vital signs stay independent of history page and clear when the selected pet changes", async ({ page }) => {
  const state = fixture();
  state.pets.push({ ...state.pets[0], id: "other", name: "Other" });
  state.medicalRecords = Array.from({ length: 21 }, (_, i) => record(String(i), "pet", new Date(Date.UTC(2026, 9, 3 - i)).toISOString().slice(0, 10), i === 20 ? 36 : 39));
  state.medicalRecords.push(record("other-latest", "other", "2026-10-02", 37));
  const api = await mockApi(page, state);
  let release: (() => void) | undefined;
  api.intercept = async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/medical-records" && url.searchParams.get("petId") === "other" && url.searchParams.get("pageSize") === "1") {
      await new Promise<void>(resolve => { release = resolve; });
      await json(route, pagedFixture(url.href, state)); return true;
    }
    return false;
  };
  await page.goto("/owner/medical-records?petId=pet");
  const summary = page.getByText("Weight", { exact: true }).locator("..").locator("..");
  await expect(summary).toContainText("39°C");
  await page.getByRole("button", { name: "Trang sau", exact: true }).last().click();
  await expect(page.getByText("Trang 2/2", { exact: true })).toBeVisible();
  await expect(page.getByText("Visit 20", { exact: true })).toBeVisible();
  await expect(summary).toContainText("39°C");
  await expect(summary).toContainText("2026-10-03");
  await page.getByRole("combobox", { name: "Chọn thú cưng", exact: true }).selectOption("other");
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(summary).not.toContainText("39°C");
  release?.();
  await expect(summary).toContainText("37°C");
});

for (const role of ["owner", "admin"]) test(`valid ${role} session and screen data survive bootstrap failure`, async ({ page }) => {
  const state = fixture(); state.medicalRecords.push(record("latest"));
  const api = await mockApi(page, state, role); api.failBootstrap = true;
  await page.goto(role === "owner" ? "/owner/medical-records?petId=pet" : "/admin/owners");
  await expect(page.getByText("Chưa cập nhật được dữ liệu mới.", { exact: false }).first()).toBeVisible();
  if (role === "owner") await expect(page.getByText("39°C", { exact: true })).toBeVisible();
  else await expect(page.locator("tbody tr").filter({ hasText: "0900000000" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBe("review-session");
  await expect(page).not.toHaveURL(/\/login$/);
});

for (const status of [401, 503]) test(`auth/me ${status} ${status === 401 ? "clears invalid" : "retains unverified"} token`, async ({ page }) => {
  const api = await mockApi(page, fixture()); api.meStatus = status;
  await page.goto("/owner/profile"); await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBe(status === 401 ? null : "review-session");
});

for (const registration of [false, true]) test(`${registration ? "registration" : "login"} succeeds despite unavailable bootstrap`, async ({ page }) => {
  const api = await mockApi(page, fixture(), "owner", false); api.failBootstrap = true;
  await page.goto(registration ? "/register" : "/login");
  await page.getByLabel("Email *", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password *", { exact: true }).fill("Password123");
  if (registration) await page.getByLabel("Confirm password *", { exact: true }).fill("Password123");
  await page.getByRole("button", { name: registration ? "Create owner account" : "Sign in", exact: true }).click();
  await expect(page).toHaveURL(registration ? /\/owner\/pets$/ : /\/owner\/dashboard$/);
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBe("new-session");
});

for (const image of [false, true]) test(`${image ? "image upload" : "notification send"} waits, keeps failed draft, and reports saved data with failed refresh`, async ({ page }) => {
  const state = fixture(), api = await mockApi(page, state, "admin");
  api.failWrite = true; api.holdWrite = true;
  api.intercept = async route => {
    if (route.request().method() !== "POST" || !route.request().url().endsWith(image ? "/medical-records/images" : "/notifications/send")) return false;
    api.writes++;
    if (api.holdWrite) await new Promise<void>(resolve => { api.release = resolve; });
    if (api.failWrite) await json(route, { error: "Write rejected" }, 503);
    else { api.failBootstrap = true; await json(route, { id: "saved" }, 201); }
    return true;
  };
  await page.goto(image ? "/admin/medical-records" : "/admin/notifications");
  if (image) {
    await page.getByRole("button", { name: "Upload diagnostic image", exact: true }).click();
    await page.getByRole("combobox", { name: "Pet *", exact: true }).selectOption("pet");
    await page.locator('input[type="file"]').setInputFiles({ name: "scan.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64") });
    await expect(page.getByAltText("Diagnostic image preview")).toBeVisible();
  } else {
    await page.getByRole("button", { name: "Gửi thông báo cho Chủ nuôi", exact: true }).click();
    await page.getByRole("combobox", { name: "Người nhận *", exact: true }).selectOption("owner");
    await page.getByRole("button", { name: "Tùy chỉnh", exact: true }).click();
    await page.getByPlaceholder("Nhập nội dung gửi chủ nuôi...").fill("Draft body");
  }
  const title = page.getByPlaceholder(image ? "Example: Chest X-ray" : "Nhập tiêu đề thông báo...");
  await title.fill("Draft title");
  const submit = () => page.getByRole("button", { name: image ? "Save image" : "Gửi thông báo ngay", exact: true });
  await submit().click();
  await expect.poll(() => api.writes).toBe(1);
  await expect(page.getByRole("button", { name: image ? "Đang lưu ảnh..." : "Đang gửi thông báo...", exact: true })).toBeDisabled();
  await expect(title).toBeDisabled(); await expect(page.getByRole("status")).toHaveCount(0);
  api.release();
  await expect(page.getByRole("alert").filter({ hasText: "Write rejected" })).toBeVisible();
  await expect(title).toHaveValue("Draft title");
  api.failWrite = false;
  await submit().click(); await expect.poll(() => api.writes).toBe(2);
  api.release();
  await expect(page.getByRole("status").last()).toContainText(image ? "Đã lưu ảnh nhưng chưa tải lại được dữ liệu" : "Đã gửi thông báo nhưng chưa tải lại được dữ liệu");
  if (image) await expect(title).toHaveCount(0); else await expect(title).toHaveValue("");
  expect(api.writes).toBe(2);
});

for (const failedRead of ["bootstrap", "invoices"]) test(`onsite selection is saved when ${failedRead} refresh fails; read retry does not send another write`, async ({ page }) => {
  const state = fixture();
  state.invoices.push({ id: "invoice", invoiceCode: "INV-1", ownerId: "owner", petId: "pet", items: [], paymentStatus: "unpaid", totalAmount: 100000, taxAmount: 0, discountAmount: 0, issuedAt: "2026-10-03" });
  const api = await mockApi(page, state);
  api.intercept = async route => {
    if (api.writes && failedRead === "invoices" && route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/invoices") {
      await json(route, { error: "Invoice read unavailable" }, 503); return true;
    }
    if (!route.request().url().endsWith("/invoices/invoice/onsite")) return false;
    api.writes++; state.invoices[0].paymentChannel = "onsite"; api.failBootstrap = failedRead === "bootstrap";
    await json(route, { invoice: state.invoices[0] }); return true;
  };
  await page.goto("/owner/billing");
  await page.getByRole("button", { name: "Thanh toán tại cửa hàng", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Đã ghi nhận thao tác" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Đã chọn thanh toán tại cửa hàng" })).toBeVisible();
  await page.getByRole("button", { name: "Tải lại", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Chưa tải lại được dữ liệu. Hãy thử tải lại." })).toBeVisible();
  expect(api.writes).toBe(1);
});

test("profile update distinguishes rejected write from saved profile with failed refresh", async ({ page }) => {
  const state = fixture(), api = await mockApi(page, state); api.failWrite = true;
  api.intercept = async route => {
    if (route.request().method() !== "PATCH" || !route.request().url().endsWith("/auth/me")) return false;
    api.writes++;
    if (api.failWrite) await json(route, { error: "Profile rejected" }, 503);
    else {
      Object.assign(state.owners[0], route.request().postDataJSON()); api.failBootstrap = true;
      await json(route, { user: { ...state.owners[0], role: "owner" } });
    }
    return true;
  };
  await page.goto("/owner/profile");
  const name = page.getByLabel("Full name *", { exact: true });
  await expect(name).toHaveValue("Owner"); await name.fill("Updated owner");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Profile rejected" })).toBeVisible();
  await expect(name).toHaveValue("Updated owner"); api.failWrite = false;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu hồ sơ nhưng chưa tải lại được dữ liệu" })).toBeVisible();
  await expect(name).toHaveValue("Updated owner"); expect(api.writes).toBe(2);
});

test("hotel detail clears the previous booking on route change and can retry the new booking", async ({ page }) => {
  const api = await mockApi(page, fixture());
  let release: (() => void) | undefined, failed = true;
  api.intercept = async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/hotel-bookings/")) return false;
    const id = path.split("/").at(-1);
    if (id === "second" && failed) {
      await new Promise<void>(resolve => { release = resolve; });
      await json(route, { error: "Detail unavailable" }, 503);
    } else await json(route, { booking: { id, ownerId: "owner", petId: "pet", status: "confirmed", checkIn: "2026-10-03", checkOut: "2026-10-04", nights: 1, roomType: "standard", serviceKeys: [], totalAmount: 100000 } });
    return true;
  };
  await page.goto("/owner/hotel-bookings/first");
  await expect(page.getByText("first", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/owner/hotel-bookings/second");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByText("first", { exact: true })).toHaveCount(0);
  release?.();
  await expect(page.getByRole("alert")).toContainText("Mã cần tra cứu: second");
  failed = false;
  await page.getByRole("button", { name: "Thử lại chi tiết" }).click();
  await expect(page.getByText("second", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
