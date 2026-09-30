import { expect, test } from "@playwright/test";

test.beforeEach(async ({ baseURL }) => {
  expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
});

for (const role of ["owner", "admin"] as const) {
  test(`${role} login, persisted session and all demo pages render`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      if (response.url().includes("/api/") && response.status() >= 400) {
        errors.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(role === "owner" ? "/login" : "/admin/login");
    await page.getByLabel(role === "owner" ? "Email *" : "Username *", { exact: true })
      .fill(role === "owner" ? "owner@example.com" : "admin");
    await page.getByLabel("Password *", { exact: true }).fill(role === "owner" ? "owner123" : "admin123");
    await page.getByRole("button", { name: role === "owner" ? "Sign in" : "Sign in as admin", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${role}/dashboard$`));
    const routes = role === "owner"
      ? ["dashboard", "profile", "pets", "medical-records", "appointments", "spa-booking", "hotel-booking", "notifications", "billing"]
      : ["dashboard", "appointments", "pets", "medical-records", "hotel-bookings", "notifications", "analytics", "billing", "settings"];
    for (const route of routes) {
      // Full navigation tests session restoration as well as component rendering.
      const bootstrap = page.waitForResponse(response => response.url().includes("/api/bootstrap") && response.status() === 200);
      await page.goto(`/${role}/${route}`);
      await bootstrap;
      await expect(page.locator("main")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/${role}/${route}$`));
      await expect(page.locator("main")).not.toBeEmpty();
    }
    expect(errors).toEqual([]);
  });
}

test("unauthenticated guards and public rescue page", async ({ page }) => {
  await page.goto("/owner/pets");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/admin/pets");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/rescue/mochi-rescue-demo");
  await expect(page.getByText("Mochi", { exact: true }).first()).toBeVisible();
});

test("QR page obeys public medical flags without exposing internal notes", async ({ page, request }) => {
  const api = process.env.API_BASE_URL || "http://127.0.0.1:5000/api";
  const login = await request.post(`${api}/auth/owner/login`, { data: { email: "owner@example.com", password: "owner123" } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}` };
  const created = await request.post(`${api}/pets`, { headers, data: {
    name: "QR privacy fixture", species: "dog", healthStatus: "critical", allergies: ["SECRET_BROWSER_ALLERGY"],
    notes: "SECRET_BROWSER_NOTE", publicProfile: { showMedicalAlerts: false, rescueNote: "Safe public rescue note" },
  } });
  expect(created.status()).toBe(201);
  const { pet } = await created.json();
  expect(pet.qrToken).toBeTruthy();
  const publicUrl = `${api}/public/pets/${pet.qrToken}`;
  const hidden = await request.get(publicUrl);
  expect(hidden.status()).toBe(200);
  const hiddenBody = await hidden.text();
  expect(hiddenBody).not.toContain("SECRET_BROWSER_ALLERGY");
  expect(hiddenBody).not.toContain("SECRET_BROWSER_NOTE");
  expect(hiddenBody).not.toContain("critical");
  await page.goto(`/rescue/${pet.qrToken}`);
  await expect(page.getByText("QR privacy fixture").first()).toBeVisible();
  await expect(page.locator("body")).toContainText("Safe public rescue note");
  await expect(page.locator("body")).not.toContainText("SECRET_BROWSER_ALLERGY");

  const enabled = await request.patch(`${api}/pets/${pet.id}`, { headers, data: { publicProfile: { showMedicalAlerts: true } } });
  expect(enabled.status()).toBe(200);
  const shown = await request.get(publicUrl);
  expect(shown.status()).toBe(200);
  const shownBody = await shown.text();
  expect(shownBody).toContain("SECRET_BROWSER_ALLERGY");
  expect(shownBody).not.toContain("SECRET_BROWSER_NOTE");
  await page.reload();
  await expect(page.locator("body")).toContainText("SECRET_BROWSER_ALLERGY");
  await expect(page.locator("body")).not.toContainText("SECRET_BROWSER_NOTE");

  const disabled = await request.patch(`${api}/pets/${pet.id}`, { headers, data: { qrEnabled: false } });
  expect(disabled.status()).toBe(200);
  expect((await request.get(publicUrl)).status()).toBe(404);
  await page.reload();
  await expect(page.getByText("QR privacy fixture")).toHaveCount(0);
  expect((await request.get(`${api}/public/pets/not-a-real-qr-token`)).status()).toBe(404);
});
