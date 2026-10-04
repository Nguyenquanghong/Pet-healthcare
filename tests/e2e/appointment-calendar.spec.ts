import { expect, test, type Page } from "@playwright/test";
import type { Appointment } from "../../frontend/src/types/appointment";

// Exercise the real calendar without writing to the demo database.
async function mockCalendar(page: Page, spa = false, dates = ["2026-10-02", "2026-10-05"]) {
  await page.clock.install({ time: new Date("2026-10-03T05:00:00Z") });
  await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "calendar-test-session"));
  const appointments: Appointment[] = dates.map((date, index) => ({
    id: `visit-${index}`, date, time: "09:00", petId: "pet", ownerId: "owner",
    type: spa ? "spa_bath" : "general_checkup", serviceName: index ? "Other visit" : "First visit",
    clinicName: "Mock clinic", status: "pending", statusRevision: 0, createdBy: "owner",
    createdAt: "2026-10-03T05:00:00Z", updatedAt: "2026-10-03T05:00:00Z",
  }));
  const state = {
    currentOwnerId: "owner", owners: [{ id: "owner", fullName: "Mock Owner", phone: "0900000000", petIds: ["pet"] }],
    pets: [{ id: "pet", ownerId: "owner", name: "Mochi", species: "cat", breed: "Cat", allergies: [] }],
    appointments, medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [],
  };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    expect(request.method()).toBe("GET");
    expect(["/api/auth/me", "/api/bootstrap"]).toContain(path);
    return route.fulfill({ json: path === "/api/auth/me" ? { user: { id: "owner", role: "owner" } } : state, headers });
  });
}

const calendar = (page: Page) => page.getByRole("heading", { name: /^Lịch Tháng / }).locator("../../..");

for (const [today, tomorrow] of [
  ["2026-10-03", "2026-10-04"], ["2026-10-04", "2026-10-05"],
  ["2026-10-31", "2026-11-01"], ["2026-12-31", "2027-01-01"],
]) test(`opening medical booking on ${today} defaults to ${tomorrow}`, async ({ page }) => {
  await mockCalendar(page);
  await page.clock.setFixedTime(new Date(`${today}T12:00:00+07:00`));
  await page.goto("/owner/appointments");
  await expect(page.getByLabel("Ngày khám", { exact: true })).toHaveValue(tomorrow);
});

for (const spa of [false, true]) test(`${spa ? "spa" : "medical"} calendar aligns October 1 under Thursday`, async ({ page }) => {
  await mockCalendar(page, spa);
  await page.goto(spa ? "/owner/spa-booking" : "/owner/appointments");
  const days = calendar(page).locator("button[aria-pressed]");
  await expect(days).toHaveCount(31);
  const thursday = await days.nth(0).boundingBox(), monday = await days.nth(4).boundingBox();
  expect(thursday!.x).toBeGreaterThan(monday!.x + monday!.width * 2);
  await expect(calendar(page).getByText("Thứ 5", { exact: true })).toBeVisible();
  await expect(days.nth(1)).toBeEnabled();
  await expect(days.nth(2)).toBeDisabled();
  if (!spa) await calendar(page).screenshot({ path: "test-results/appointment-calendar-after.png" });
});

for (const navigation of ["next", "dropdown"] as const) test(`changing calendar month via ${navigation} clears the previous day filter`, async ({ page }) => {
  await mockCalendar(page);
  await page.goto("/owner/appointments");
  await calendar(page).locator("button[aria-pressed]").nth(1).click();
  await expect(page.getByText("Đang xem 1 lịch hẹn vào ngày 2026-10-02")).toBeVisible();
  await expect(page.getByText("Other visit", { exact: true })).toHaveCount(0);
  if (navigation === "next") await page.getByRole("button", { name: "Tháng sau", exact: true }).click();
  else await page.getByLabel("Chọn tháng").selectOption("10");
  await expect(page.getByRole("heading", { name: "Lịch Tháng 11 / 2026" })).toBeVisible();
  await expect(page.getByText("Đang xem 1 lịch hẹn vào ngày 2026-10-02")).toHaveCount(0);
  await expect(page.getByText("Other visit", { exact: true })).toBeVisible();
});

test("calendar keeps the appointment count above the date on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockCalendar(page);
  await page.goto("/owner/appointments");
  const days = calendar(page).locator("button[aria-pressed]");
  await expect(days).toHaveCount(31);
  const day = days.nth(1), badge = await day.locator("span").boundingBox(), number = await day.locator("p").boundingBox();
  expect(badge!.y + badge!.height).toBeLessThanOrEqual(number!.y);
  await calendar(page).screenshot({ path: "test-results/appointment-calendar-mobile-after.png" });
});

test("calendar handles leap February, year rollover and a month starting on Sunday", async ({ page }) => {
  await mockCalendar(page, false, ["2024-02-02", "2024-02-05"]);
  await page.goto("/owner/appointments");
  const days = calendar(page).locator("button[aria-pressed]");
  await expect(page.getByRole("heading", { name: "Lịch Tháng 2 / 2024" })).toBeVisible();
  await expect(days).toHaveCount(29);
  await page.getByLabel("Chọn tháng").selectOption("11");
  await page.getByRole("button", { name: "Tháng sau", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lịch Tháng 1 / 2025" })).toBeVisible();
  await page.getByLabel("Chọn tháng").selectOption("1");
  await expect(days).toHaveCount(28);
  await page.getByLabel("Chọn tháng").selectOption("5");
  const sunday = await days.nth(0).boundingBox(), monday = await days.nth(1).boundingBox();
  expect(sunday!.x).toBeGreaterThan(monday!.x + monday!.width * 5);
});
