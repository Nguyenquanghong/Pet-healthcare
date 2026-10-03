import { pagedFixture } from "./pagination-fixture";
import { expect, test, type Page } from "@playwright/test";
import type { Appointment, AppointmentStatus } from "../../frontend/src/types/appointment";

// Exercise the real frontend with a controlled API, without touching a demo database.
const appointment = (id: string, status: AppointmentStatus): Appointment => ({
  id, status, petId: "pet", ownerId: "owner", type: "general_checkup", serviceName: id,
  clinicName: "Test clinic", date: "2039-01-01", time: "10:00", statusRevision: 0,
  createdBy: "owner", createdAt: "2038-12-01", updatedAt: "2038-12-01",
});

async function mockApi(page: Page, role = "admin") {
  const state = {
    currentOwnerId: "owner",
    owners: [{ id: "owner", fullName: "Chủ nuôi thử nghiệm", phone: "0900000000", petIds: ["pet"] }],
    pets: [{ id: "pet", ownerId: "owner", name: "Milo", species: "dog", breed: "Poodle", gender: "male", healthStatus: "healthy", allergies: [] }],
    appointments: [appointment("Lịch đã hủy", "cancelled"), appointment("Lịch hoàn thành", "completed"), appointment("Lịch đang chờ", "pending")],
    medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [],
    hotelBookings: ["cancelled", "checked_out", "pending", "rejected"].map(status => ({
      id: status, status, petId: "pet", ownerId: "owner", checkIn: "2039-01-01", checkOut: "2039-01-02",
      nights: 1, roomType: "standard", totalAmount: 350000, serviceKeys: [], dailyCareNoteIds: [], statusRevision: 0,
    })),
  };
  const control = { state, reads: 0, fail: false, holdNext: false, release: () => {}, listReads: 0, failList: false, holdNextList: false, listHeld: false, releaseList: () => {} };
  await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "test-session"));
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*",
    } });
    if (path.endsWith("/auth/me")) return json({ user: { role } });
    if (path.endsWith("/bootstrap")) {
      control.reads += 1;
      if (control.fail) return json({ error: "Temporary outage" }, 503);
      const snapshot = structuredClone(state);
      if (control.holdNext) {
        control.holdNext = false;
        await new Promise<void>(resolve => { control.release = resolve; });
      }
      return json(snapshot);
    }
    if (req.method() === "GET") {
      const paged = pagedFixture(req.url(), state);
      if (paged) {
        if (path.endsWith("/appointments")) {
          control.listReads += 1;
          if (control.failList) return json({ error: "List unavailable" }, 503);
          if (control.holdNextList) {
            control.holdNextList = false; control.listHeld = true;
            await new Promise<void>(resolve => { control.releaseList = resolve; });
          }
        }
        return json(paged);
      }
    }
    if (path.includes("/appointments/") && req.method() === "PATCH") {
      const id = decodeURIComponent(path.split("/")[3]);
      const item = state.appointments.find(a => a.id === id)!;
      Object.assign(item, req.postDataJSON(), { statusRevision: item.statusRevision + 1 });
      return json({ appointment: item });
    }
    if (path.endsWith("/invoices")) return json([]);
    return json({ error: `Unexpected API call: ${path}` }, 501);
  });
  await page.clock.install();
  return control;
}

test("admin receives new appointments without reload, with cancelled entries last", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Lịch đang chờ");
  await expect(rows.nth(1)).toContainText("Lịch hoàn thành");
  await expect(rows.nth(2)).toContainText("Lịch đã hủy");
  api.state.appointments.unshift(appointment("Khách vừa đặt từ phiên khác", "pending"));
  await page.clock.runFor(10_000);
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("Khách vừa đặt từ phiên khác");
  await page.getByRole("button", { name: /^Đã hủy/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Lịch đã hủy");
});

test("refresh recovers after errors and preserves filters and an unsaved note", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await page.getByPlaceholder("Tìm theo tên thú cưng, chủ nuôi, sđt, dịch vụ...").fill("Lịch đang chờ");
  await page.getByTitle("Ghi chú nội bộ", { exact: true }).click();
  const note = page.getByPlaceholder("Nhập dặn dò bác sĩ, tiền sử bệnh án, lưu ý tiếp đón...");
  await note.fill("Nội dung đang nhập");
  api.fail = true;
  await page.clock.runFor(10_000);
  await expect(page.getByRole("status")).toContainText("Chưa cập nhật");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(note).toHaveValue("Nội dung đang nhập");
  api.fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(note).toHaveValue("Nội dung đang nhập");
});

test("a slow background response cannot overwrite a saved staff edit", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  const row = page.locator("tbody tr").filter({ hasText: "Lịch đang chờ" });
  await expect(row).toBeVisible();
  api.holdNext = true;
  const readsBefore = api.reads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.reads).toBe(readsBefore + 1);
  await row.getByTitle("Ghi chú nội bộ", { exact: true }).click();
  await page.getByPlaceholder("Nhập dặn dò bác sĩ, tiền sử bệnh án, lưu ý tiếp đón...").fill("Ghi chú mới đã lưu");
  await page.getByRole("button", { name: "Lưu ghi chú", exact: true }).click();
  await expect(row).toContainText("Ghi chú mới đã lưu");
  const response = page.waitForResponse(response => response.url().includes("/api/bootstrap"));
  api.release(); await response;
  await expect(row).toContainText("Ghi chú mới đã lưu");
});

test("hidden tabs pause polling and refresh on return; logout ignores an in-flight response", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  const readsBefore = api.reads;
  await page.clock.runFor(30_000);
  expect(api.reads).toBe(readsBefore);
  api.state.appointments.unshift(appointment("Lịch mới khi vắng mặt", "confirmed"));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("tbody tr")).toHaveCount(4);
  api.holdNext = true;
  const readsAfter = api.reads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.reads).toBe(readsAfter + 1);
  await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBeNull();
  api.release();
  await page.clock.runFor(20_000);
  expect(api.reads).toBe(readsAfter + 1);
  await expect(page.getByText("Lịch mới khi vắng mặt", { exact: true })).toHaveCount(0);
});

test("admin hotel bookings prioritize active stays and keep cancelled/rejected last", async ({ page }) => {
  await mockApi(page);
  await page.goto("/admin/hotel-bookings");
  const cards = page.locator('[data-testid^="hotel-booking-"]');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toHaveAttribute("data-testid", "hotel-booking-pending");
  await expect(cards.nth(1)).toHaveAttribute("data-testid", "hotel-booking-checked_out");
  await expect(cards.nth(2)).toHaveAttribute("data-testid", "hotel-booking-cancelled");
  await expect(cards.nth(3)).toHaveAttribute("data-testid", "hotel-booking-rejected");
});

test("owner sees new appointment status without reloading", async ({ page }) => {
  const api = await mockApi(page, "owner");
  await page.goto("/owner/appointments");
  await expect(page.getByText("Lịch đang chờ", { exact: true })).toBeVisible();
  api.state.appointments.find(a => a.status === "pending")!.serviceName = "Lịch vừa được nhân viên cập nhật";
  await page.clock.runFor(10_000);
  await expect(page.getByText("Lịch vừa được nhân viên cập nhật", { exact: true })).toBeVisible();
});

test("lists still refresh when bootstrap fails", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  api.fail = true;
  api.state.appointments.unshift(appointment("Lịch mới khi bootstrap lỗi", "pending"));
  await page.clock.runFor(10_000);
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await expect(page.locator("tbody")).toContainText("Lịch mới khi bootstrap lỗi");
  await expect(page.getByRole("status")).toContainText("Chưa cập nhật");
});

test("a failed list refresh keeps its rows and can retry independently", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  api.failList = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const error = page.getByRole("alert").filter({ hasText: "List unavailable" });
  await expect(error).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  api.failList = false;
  api.state.appointments.unshift(appointment("Lịch mới sau khi thử lại", "pending"));
  await error.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await expect(error).toHaveCount(0);
});

test("a timed-out list request can retry without accepting its late response", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  api.holdNextList = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.listHeld).toBe(true);
  const error = page.getByRole("navigation", { name: "Phân trang" }).getByRole("alert");
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("tbody tr")).toHaveCount(3);
  api.state.appointments.unshift(appointment("Lịch mới sau timeout", "pending"));
  await error.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  api.releaseList();
  await expect(page.locator("tbody")).toContainText("Lịch mới sau timeout");
});

test("a pending bootstrap does not block the next list refresh", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  const before = api.reads;
  api.holdNext = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.reads).toBe(before + 1);
  api.state.appointments.unshift(appointment("Lịch mới khi bootstrap đang chờ", "pending"));
  await page.clock.runFor(10_000);
  await expect(page.locator("tbody tr")).toHaveCount(4);
  expect(api.reads).toBe(before + 1);
  const response = page.waitForResponse(response => response.url().includes("/api/bootstrap"));
  api.release(); await response;
  await expect(page.locator("tbody")).toContainText("Lịch mới khi bootstrap đang chờ");
});

test("poll signals share an in-flight list, while a saved edit replaces its older response", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  const row = page.locator("tbody tr").filter({ hasText: "Lịch đang chờ" });
  await expect(row).toBeVisible();
  api.holdNextList = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.listHeld).toBe(true);
  const heldReads = api.listReads;
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  await page.clock.runFor(1_000);
  expect(api.listReads).toBe(heldReads);
  let discarded = 0;
  page.on("requestfailed", request => { if (new URL(request.url()).pathname.endsWith("/appointments")) discarded += 1; });
  await row.getByTitle("Ghi chú nội bộ", { exact: true }).click();
  await page.getByPlaceholder("Nhập dặn dò bác sĩ, tiền sử bệnh án, lưu ý tiếp đón...").fill("Bản ghi mới sau thao tác lưu");
  await page.getByRole("button", { name: "Lưu ghi chú", exact: true }).click();
  await expect(row).toContainText("Bản ghi mới sau thao tác lưu");
  expect(api.listReads).toBeGreaterThan(heldReads);
  api.releaseList();
  await expect.poll(() => discarded).toBeGreaterThan(0);
  await expect(row).toContainText("Bản ghi mới sau thao tác lưu");
});

test("logout cancels an in-flight list and stops background reads", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await expect(page.locator("tbody tr")).toHaveCount(3);
  api.holdNextList = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => api.listHeld).toBe(true);
  const reads = api.listReads;
  await page.getByRole("button", { name: "Đăng xuất", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  api.releaseList();
  await page.clock.runFor(20_000);
  expect(api.listReads).toBe(reads);
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBeNull();
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

test("calendar ignores an earlier month response and retries without losing the current month", async ({ page }) => {
  await mockApi(page, "owner");
  let firstMonth = "", latestMonth = "", heldMonth = "", holdNext = false, fail = false;
  let release: (() => void) | undefined;
  await page.route("**/api/appointments/calendar**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*",
    } });
    const month = new URL(route.request().url()).searchParams.get("month")!;
    firstMonth ||= month; latestMonth = month;
    const count = holdNext ? 99 : 7;
    if (holdNext) { holdNext = false; heldMonth = month; await new Promise<void>(resolve => { release = resolve; }); }
    return route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "Calendar unavailable" } : { [`${month}-05`]: count }, headers: { "access-control-allow-origin": "*" } });
  });
  await page.goto("/owner/appointments");
  await expect.poll(() => firstMonth).not.toBe("");
  await expect(page.getByRole("button", { name: `${firstMonth}-05, 7 lịch hẹn`, exact: true })).toBeEnabled();
  holdNext = true;
  await page.getByRole("button", { name: "Tháng sau", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("button", { name: "Tháng sau", exact: true }).click();
  await expect.poll(() => latestMonth !== heldMonth).toBe(true);
  const currentMonth = latestMonth;
  const day = page.getByRole("button", { name: `${currentMonth}-05, 7 lịch hẹn`, exact: true });
  await expect(day).toBeEnabled();
  release?.();
  fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const error = page.getByRole("alert").filter({ hasText: "Chưa tải được lịch theo tháng." });
  await expect(error).toBeVisible();
  await expect(day).toBeEnabled();
  fail = false;
  await error.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(day).toBeEnabled();
  await expect(page.getByLabel("Chọn tháng", { exact: true })).toHaveValue(String(Number(currentMonth.slice(5, 7)) - 1));
});
