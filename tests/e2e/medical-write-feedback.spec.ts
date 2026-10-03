import { pagedFixture } from "./pagination-fixture";
import { expect, test } from "@playwright/test";

test("medical write waits for HTTP and distinguishes failure from saved data with failed refresh", async ({ page }) => {
  const state = {
    currentOwnerId: "owner",
    owners: [{ id: "owner", fullName: "Chủ nuôi", phone: "0900000000", petIds: ["pet"] }],
    pets: [{ id: "pet", ownerId: "owner", name: "Mochi", species: "dog", breed: "Shiba", allergies: [] }],
    appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [],
  };
  let writeStarted = 0;
  let releaseWrite: (() => void) | undefined;
  let failWrite = true;
  let failRefresh = false;
  await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "test-session"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const response = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } });
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*",
    } });
    if (path.endsWith("/auth/me")) return response({ user: { role: "admin" } });
    if (path.endsWith("/bootstrap")) return failRefresh ? response({ error: "Reload unavailable" }, 503) : response(structuredClone(state));
    if (route.request().method() === "GET") { const paged = pagedFixture(route.request().url(), state); if (paged) return response(paged); }

    if (path.endsWith("/medical-records") && route.request().method() === "POST") {
      writeStarted++;
      await new Promise<void>(resolve => { releaseWrite = resolve; });
      if (failWrite) return response({ error: "Không thể lưu bệnh án" }, 503);
      state.medicalRecords.push({ ...route.request().postDataJSON(), id: "record", ownerId: "owner",
        createdAt: "2038-01-01", updatedAt: "2038-01-01" });
      failRefresh = true;
      return response({ record: state.medicalRecords[0] }, 201);
    }
    if (path.endsWith("/invoices")) return response([]);
    return response({ error: `Unexpected request ${path}` }, 501);
  });
  await page.goto("/admin/medical-records");
  await page.getByRole("button", { name: "Tạo hồ sơ mới" }).click();
  await page.getByRole("combobox", { name: "Thú cưng *", exact: true }).selectOption("pet");
  await page.getByPlaceholder("VD: Khám tổng quát định kỳ").fill("Kiểm tra sức khỏe");
  await page.getByPlaceholder("Kết quả chẩn đoán...").fill("Khỏe");
  await page.getByPlaceholder("Hướng điều trị...").fill("Theo dõi");
  await page.getByRole("button", { name: "Lưu hồ sơ y tế" }).click();
  await expect.poll(() => writeStarted).toBe(1);
  await expect(page.getByRole("button", { name: "Đang lưu..." })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  releaseWrite?.();
  await expect(page.getByText("Không thể lưu bệnh án").last()).toBeVisible();
  await expect(page.getByPlaceholder("VD: Khám tổng quát định kỳ")).toHaveValue("Kiểm tra sức khỏe");
  failWrite = false;
  await page.getByRole("button", { name: "Lưu hồ sơ y tế" }).click();
  await expect.poll(() => writeStarted).toBe(2);
  await expect(page.getByRole("status")).toHaveCount(0);
  releaseWrite?.();
  await expect(page.getByRole("status").last()).toContainText("Đã lưu bệnh án nhưng chưa tải lại được dữ liệu");
  await expect(page.getByPlaceholder("VD: Khám tổng quát định kỳ")).toHaveCount(0);
  expect(writeStarted).toBe(2);
});
