import { pagedFixture } from "./pagination-fixture";
import { expect, test, type Page } from "@playwright/test";

async function mockOwner(page: Page, name = "Mochi") {
  const pet = { id: "pet", ownerId: "owner", name, species: "cat", breed: "<img src=x onerror=alert(1)>",
    gender: "female", ageLabel: "1 tuổi", healthStatus: "healthy", allergies: [], qrToken: "old-token", qrEnabled: true,
    publicProfile: { showOwnerPhone: true, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: true, rescueNote: "Old note" } };
  const state = { currentOwnerId: "owner", owners: [{ id: "owner", fullName: "Owner", phone: "<svg onload=alert(2)>", petIds: ["pet"] }],
    pets: [pet], appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [] };
  const control = { pet, failWrite: false, failRefresh: false, writes: [] as { path: string; body: unknown }[] };
  await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "test-session"));
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (path.endsWith("/auth/me")) return json({ user: { role: "owner" } });
    if (path.endsWith("/bootstrap")) return control.failRefresh ? json({ error: "Refresh unavailable" }, 503) : json(structuredClone(state));
    if (req.method() === "GET") { const paged = pagedFixture(req.url(), state); if (paged) return json(paged); }

    if (req.method() === "POST" || req.method() === "PATCH") {
      const body = req.postDataJSON(); control.writes.push({ path, body });
      if (control.failWrite) return json({ error: "Không thể lưu QR" }, 422);
      if (path.endsWith("/qr-token")) { pet.qrToken = "server-new-token"; return json({ pet }); }
      if (body.publicProfile) Object.assign(pet.publicProfile, body.publicProfile);
      if (body.qrEnabled !== undefined) pet.qrEnabled = body.qrEnabled;
      return json({ pet });
    }
    return json({ error: `Unexpected ${path}` }, 501);
  });
  await page.route("https://api.qrserver.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>' }));
  await page.goto("/owner/pets");
  await expect(page.getByRole("heading", { name: "Hồ sơ cứu hộ công khai" })).toBeVisible();
  return control;
}

test("printing treats stored pet and contact fields as text", async ({ page }) => {
  const name = '</title><script>opener.document.body.dataset.injected="yes"</script>';
  await mockOwner(page, name);
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    const original = window.open.bind(window);
    window.open = (...args: Parameters<typeof window.open>) => {
      const popup = original(...args);
      if (popup) { popup.print = () => {}; popup.close = () => {}; }
      return popup;
    };
  });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "In thẻ QR" }).click();
  const popup = await popupPromise;
  await expect(popup.locator(".tag-pet")).toHaveText(name);
  await expect(popup.locator(".tag-breed")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(popup.locator(".tag-phone")).toHaveText("Hotline: <svg onload=alert(2)>");
  await expect(popup.locator("script, svg, [onerror], [onload]")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.dataset.injected)).toBeUndefined();
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
});

test("QR rotation uses the server response even when bootstrap refresh fails", async ({ page }) => {
  const control = await mockOwner(page);
  control.failWrite = true;
  await page.getByRole("button", { name: "Đổi mã QR mới" }).click();
  await expect(page.getByRole("status").last()).toContainText("Không thể lưu QR");
  await expect(page.getByRole("link", { name: "Xem trang public" })).toHaveAttribute("href", /old-token$/);
  control.failWrite = false; control.failRefresh = true;
  await page.getByRole("button", { name: "Đổi mã QR mới" }).click();
  await expect(page.getByRole("status").last()).toContainText("Đã lưu nhưng chưa tải lại được dữ liệu");
  await expect(page.getByRole("link", { name: "Xem trang public" })).toHaveAttribute("href", /server-new-token$/);
  expect(control.writes.map(write => write.path)).toEqual(["/api/pets/pet/qr-token", "/api/pets/pet/qr-token"]);
  expect(control.writes.every(write => !Object.hasOwn(write.body as object, "qrToken"))).toBe(true);
});

test("rescue note saves once on submit and flag updates send only the changed field", async ({ page }) => {
  const control = await mockOwner(page);
  await page.getByLabel("Lời nhắn cứu hộ").fill("New rescue instructions");
  expect(control.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Lưu lời nhắn" }).click();
  await expect(page.getByRole("status").last()).toContainText("Đã lưu thay đổi");
  expect(control.writes[0].body).toEqual({ publicProfile: { rescueNote: "New rescue instructions" } });
  await page.getByRole("checkbox", { name: /Hiện số điện thoại/ }).click();
  await expect.poll(() => control.writes.length).toBe(2);
  await expect(page.getByRole("checkbox", { name: /Hiện số điện thoại/ })).not.toBeChecked();
  expect(control.writes[1].body).toEqual({ publicProfile: { showOwnerPhone: false } });
});

test("registration rejects short passwords before sending a write", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/**", route => { if (route.request().method() === "POST") writes++; return route.fulfill({ json: {} }); });
  await page.goto("/register");
  await page.getByLabel("Email *", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password *", { exact: true }).fill("x");
  await page.getByLabel("Confirm password *", { exact: true }).fill("x");
  await page.getByRole("button", { name: "Create owner account", exact: true }).click();
  await expect(page.getByText("Password must contain 8 to 128 characters.")).toBeVisible();
  expect(writes).toBe(0);
});
