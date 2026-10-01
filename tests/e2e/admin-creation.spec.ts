import { expect, test, type Page } from "@playwright/test";
import type { Appointment } from "../../frontend/src/types/appointment";
import type { HotelBooking } from "../../frontend/src/types/booking";
import type { Pet } from "../../frontend/src/types/pet";
import type { Owner } from "../../frontend/src/types/owner";

// Browser tests use a controlled API; the matching integration test uses real PostgreSQL.
async function mockApi(page: Page) {
  const state = {
    currentOwnerId: "",
    owners: [
      { id: "owner-a", fullName: "Khách A", phone: "0900000001", petIds: ["pet-a"] },
      { id: "owner-b", fullName: "Khách B", phone: "0900000002", petIds: ["pet-b"] },
      { id: "owner-c", fullName: "Khách C", phone: "0900000003", petIds: [] },
    ] as Owner[],
    pets: [
      { id: "pet-a", ownerId: "owner-a", name: "Milo A", species: "dog", breed: "Poodle", gender: "male", ageLabel: "", healthStatus: "healthy", allergies: [] },
      { id: "pet-b", ownerId: "owner-b", name: "Mochi B", species: "cat", breed: "Mèo Anh", gender: "female", ageLabel: "", healthStatus: "healthy", allergies: [] },
    ] as Pet[],
    appointments: [] as Appointment[], hotelBookings: [] as HotelBooking[],
    medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [],
  };
  const control = {
    state, posts: [] as { path: string; body: Record<string, unknown>; key?: string }[],
    failPost: false, failRefresh: false, loseHotelResponse: false, losePetResponse: false, loseOwnerResponse: false,
    holdPost: false, release: () => {},
  };
  await page.addInitScript(() => sessionStorage.setItem("nipopeto_access_token", "test-session"));
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: { "access-control-allow-origin": "*" } });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*",
    } });
    if (path.endsWith("/auth/me")) return json({ user: { role: "admin" } });
    if (path.endsWith("/bootstrap")) return control.failRefresh ? json({ error: "Refresh unavailable" }, 503) : json(state);
    if (path.endsWith("/invoices")) return json([]);
    if (req.method() === "POST") {
      const body = req.postDataJSON(), key = req.headers()["idempotency-key"];
      control.posts.push({ path, body, key });
      if (control.holdPost) await new Promise<void>(resolve => { control.release = resolve; });
      if (control.failPost) return json({ error: "Không lưu được dữ liệu thử nghiệm" }, 422);
      if (path === "/api/owners") {
        const digits = String(body.phone).replace(/[\s.()-]/g, "");
        const phone = /^\+?84\d{9}$/.test(digits) ? `0${digits.slice(-9)}` : digits;
        if (state.owners.some(item => item.phone === phone)) return json({ error: "Đã có hồ sơ dùng số điện thoại hoặc email này. Hãy tìm và chọn khách đã có." }, 409);
        const owner = { id: "counter-owner", ...body, phone, petIds: [] } as Owner;
        state.owners.unshift(owner);
        if (control.loseOwnerResponse) { control.loseOwnerResponse = false; return route.abort("failed"); }
        return json({ owner }, 201);
      }
      if (path === "/api/pets") {
        const pet = { id: `pet-new-${state.pets.length}`, ageLabel: "", ...body } as Pet;
        state.pets.unshift(pet);
        if (control.losePetResponse) { control.losePetResponse = false; return route.abort("failed"); }
        return json({ pet }, 201);
      }
      const pet = state.pets.find(item => item.id === body.petId)!;
      if (path === "/api/appointments") {
        const appointment = { id: "appointment-new", ownerId: pet.ownerId, status: "pending", statusRevision: 0,
          createdBy: "staff", clinicName: "Nippon Pet Care", createdAt: "2039-01-01", updatedAt: "2039-01-01", ...body } as Appointment;
        state.appointments.unshift(appointment);
        return json({ appointment }, 201);
      }
      if (path === "/api/hotel-bookings") {
        // Simulate the server having committed before the client loses the response.
        const booking = state.hotelBookings[0] || { id: "hotel-new", ownerId: pet.ownerId, status: "pending", statusRevision: 0,
          nights: 2, totalAmount: 1_320_000, dailyCareNoteIds: [], ...body } as HotelBooking;
        if (!state.hotelBookings.length) state.hotelBookings.push(booking);
        if (control.loseHotelResponse) { control.loseHotelResponse = false; return route.abort("failed"); }
        return json({ booking }, 201);
      }
    }
    return json({ error: `Unexpected API call: ${req.method()} ${path}` }, 501);
  });
  return control;
}

test("admin confirms owner identity before adding a pet and cannot double-submit", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/pets");
  await page.getByRole("button", { name: "Thêm thú cưng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tìm khách đã có", { exact: true }).fill("0900000002");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-b");
  await dialog.getByLabel("Tên thú cưng", { exact: true }).fill("Bông");
  await dialog.getByLabel("Loài", { exact: true }).selectOption("cat");
  await dialog.getByLabel("Cân nặng (kg)").fill("3.5");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await expect(dialog).toContainText("Chủ nuôi: Khách B");
  await expect(dialog).toContainText("0900000002");
  await expect(dialog).toContainText("Thú cưng mới: Bông");
  expect(api.posts).toHaveLength(0);
  api.holdPost = true;
  const confirm = dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" });
  await confirm.click();
  await expect.poll(() => api.posts.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Đang lưu..." })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  api.release();
  await expect(dialog.getByRole("status")).toContainText("Đã tạo thú cưng Bông cho Khách B");
  expect(api.posts[0].body).toMatchObject({ ownerId: "owner-b", name: "Bông", species: "cat", weightKg: 3.5 });
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Bông" })).toContainText("Khách B");
  expect(api.posts).toHaveLength(1);
});

test("walk-in customer can be created with no email, then a new pet and hotel stay in one form", async ({ page }) => {
  const api = await mockApi(page);
  api.state.owners = []; api.state.pets = [];
  await page.goto("/admin/hotel-bookings");
  await page.getByRole("button", { name: "Tạo đặt phòng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tạo khách mới", exact: true }).click();
  await dialog.getByLabel("Họ tên khách").fill("Khách lần đầu");
  await dialog.getByLabel("Số điện thoại khách").fill("0912345678");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await expect(dialog).toContainText("Khách mới: Khách lần đầu");
  await expect(dialog).toContainText("0912345678");
  expect(api.posts).toHaveLength(0);
  await dialog.getByRole("button", { name: "Xác nhận tạo khách" }).click();
  await expect(dialog.getByRole("status")).toContainText("Tiếp tục thêm thú cưng");
  await expect(dialog.getByLabel("Chủ nuôi", { exact: true })).toHaveValue("counter-owner");
  await dialog.getByLabel("Tên thú cưng", { exact: true }).fill("Bé mới tại quầy");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await expect(dialog).toContainText("Chủ nuôi: Khách lần đầu");
  await dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" }).click();
  await expect(dialog.getByRole("status")).toContainText("Đã thêm Bé mới tại quầy");
  await dialog.getByLabel("Ngày nhận phòng").fill("2039-01-01");
  await dialog.getByLabel("Ngày trả phòng").fill("2039-01-03");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await dialog.getByRole("button", { name: "Xác nhận đặt phòng" }).click();
  await expect(dialog.getByRole("status")).toContainText("Chờ xác nhận");
  expect(api.posts.map(item => item.path)).toEqual(["/api/owners", "/api/pets", "/api/hotel-bookings"]);
  expect(api.posts[0].body.email).toBe("");
  expect(api.posts[0].body.password).toBeUndefined();
  expect(api.posts[1].body.ownerId).toBe("counter-owner");
  expect(api.posts[2].body.petId).toBe(api.state.pets[0].id);
  expect(await page.evaluate(() => sessionStorage.getItem("nipopeto_access_token"))).toBe("test-session");
});

test("duplicate walk-in phone returns to existing customer selection without overwriting the profile", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await page.getByRole("button", { name: "Tạo lịch khám / Spa", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tạo khách mới", exact: true }).click();
  await dialog.getByLabel("Họ tên khách").fill("Tên nhập khác");
  await dialog.getByLabel("Số điện thoại khách").fill("+84 900 000 001");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await dialog.getByRole("button", { name: "Xác nhận tạo khách" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Đã có hồ sơ");
  await dialog.getByRole("button", { name: "Tìm khách đã có", exact: true }).click();
  await expect(dialog.getByLabel("Tìm khách đã có", { exact: true })).toHaveValue("0900000001");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-a");
  await dialog.getByLabel("Thú cưng", { exact: true }).selectOption("pet-a");
  expect(api.state.owners).toHaveLength(3);
  expect(api.state.owners.find(item => item.id === "owner-a")?.fullName).toBe("Khách A");
  expect(api.posts).toHaveLength(1);
});

test("creating a customer inside the pet form works when the following bootstrap refresh fails", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/pets");
  await page.getByRole("button", { name: "Thêm thú cưng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tạo khách mới", exact: true }).click();
  await dialog.getByLabel("Họ tên khách").fill("Khách tạo trong form thú");
  await dialog.getByLabel("Số điện thoại khách").fill("0923456789");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  api.failRefresh = true;
  await dialog.getByRole("button", { name: "Xác nhận tạo khách" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Chưa tải lại");
  await expect(dialog.getByLabel("Chủ nuôi", { exact: true })).toHaveValue("counter-owner");
  await dialog.getByLabel("Tên thú cưng", { exact: true }).fill("Bé C");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" }).click();
  await expect(dialog.getByRole("status")).toContainText("Đã tạo thú cưng Bé C");
  expect(api.posts.map(item => item.path)).toEqual(["/api/owners", "/api/pets"]);
  expect(api.state.pets[0].ownerId).toBe("counter-owner");
});

test("lost customer creation response does not offer another create until the staff checks the list", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await page.getByRole("button", { name: "Tạo lịch khám / Spa", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tạo khách mới", exact: true }).click();
  await dialog.getByLabel("Họ tên khách").fill("Khách mất phản hồi");
  await dialog.getByLabel("Số điện thoại khách").fill("0934567890");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  api.loseOwnerResponse = true;
  await dialog.getByRole("button", { name: "Xác nhận tạo khách" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Chưa xác định yêu cầu đã được lưu");
  await expect(dialog.getByRole("button", { name: "Xác nhận tạo khách" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Tải và kiểm tra danh sách" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Tạo lịch khám / Spa", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Tìm khách đã có", { exact: true }).fill("0934567890");
  await page.getByRole("dialog").getByLabel("Chủ nuôi", { exact: true }).selectOption("counter-owner");
  expect(api.posts).toHaveLength(1);
});

test("changing owners clears the previous pet before creating a spa appointment", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await page.getByRole("button", { name: "Tạo lịch khám / Spa", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-a");
  await dialog.getByLabel("Thú cưng", { exact: true }).selectOption("pet-a");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-b");
  await expect(dialog.getByLabel("Thú cưng", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Kiểm tra thông tin" })).toBeDisabled();
  await expect(dialog.getByRole("option", { name: /Milo A/ })).toHaveCount(0);
  await dialog.getByLabel("Thú cưng", { exact: true }).selectOption("pet-b");
  await dialog.getByLabel("Dịch vụ", { exact: true }).selectOption("spa_bath");
  await dialog.getByLabel("Ngày hẹn").fill("2039-01-02");
  await dialog.getByLabel("Giờ hẹn").fill("10:30");
  await dialog.getByLabel("Yêu cầu của khách").fill("Da nhạy cảm");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await expect(dialog).toContainText("Thú cưng: Mochi B");
  await expect(dialog).toContainText("Tắm & sấy");
  await dialog.getByRole("button", { name: "Xác nhận tạo lịch" }).click();
  await expect(dialog.getByRole("status")).toContainText("Chờ xác nhận");
  expect(api.posts[0].body).toMatchObject({ petId: "pet-b", type: "spa_bath", serviceName: "Tắm & sấy", ownerNote: "Da nhạy cảm" });
  await dialog.getByRole("button", { name: "Đóng", exact: true }).click();
  const row = page.locator("tbody tr").filter({ hasText: "Mochi B" });
  await expect(row).toContainText("Nhân viên tạo");
  await expect(row).toContainText("Chờ xác nhận");
  await expect(row.getByRole("button", { name: "Lịch sử thao tác" })).toBeVisible();
});

test("an owner without pets can add a pet inside the appointment form", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/appointments");
  await page.getByRole("button", { name: "Tạo lịch khám / Spa", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-c");
  await dialog.getByRole("button", { name: "Thêm thú cưng cho chủ nuôi này" }).click();
  await dialog.getByLabel("Tên thú cưng", { exact: true }).fill("Thú mới C");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" }).click();
  await expect(dialog.getByRole("status")).toContainText("Đã thêm Thú mới C");
  await expect(dialog.getByLabel("Thú cưng", { exact: true })).toHaveValue(api.state.pets[0].id);
  await dialog.getByLabel("Ngày hẹn").fill("2039-01-02");
  await dialog.getByLabel("Giờ hẹn").fill("09:00");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await dialog.getByRole("button", { name: "Xác nhận tạo lịch" }).click();
  await expect(dialog.getByRole("status")).toContainText("Đã tạo lịch");
  expect(api.posts.map(item => item.path)).toEqual(["/api/pets", "/api/appointments"]);
  expect(api.posts[1].body.petId).toBe(api.state.pets[0].id);
  expect(api.state.appointments[0].ownerId).toBe("owner-c");
});

test("hotel retries reuse the key after a lost response and do not collect money at booking", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/hotel-bookings");
  await page.getByRole("button", { name: "Tạo đặt phòng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-a");
  await dialog.getByLabel("Thú cưng", { exact: true }).selectOption("pet-a");
  await dialog.getByLabel("Ngày nhận phòng").fill("2039-01-01");
  await dialog.getByLabel("Ngày trả phòng").fill("2039-01-03");
  await dialog.getByLabel("Loại phòng").selectOption("deluxe");
  await dialog.getByLabel(/Đi dạo hàng ngày/).check();
  await expect(dialog).toContainText("Chưa tạo hóa đơn hoặc VietQR");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  await expect(dialog).toContainText("2 đêm");
  api.loseHotelResponse = true;
  await dialog.getByRole("button", { name: "Xác nhận đặt phòng" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Xác nhận đặt phòng" }).click();
  await expect(dialog.getByRole("status")).toContainText("Chờ xác nhận");
  expect(api.posts).toHaveLength(2);
  expect(api.posts[0].key).toMatch(/^[a-z0-9-]{36}$/);
  expect(api.posts[1].key).toBe(api.posts[0].key);
  expect(api.posts[1].body).toEqual(api.posts[0].body);
  expect(api.state.hotelBookings).toHaveLength(1);
});

test("failed writes keep the confirmation, while a failed reload cannot cause a second create", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/pets");
  await page.getByRole("button", { name: "Thêm thú cưng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-a");
  await dialog.getByLabel("Tên thú cưng", { exact: true }).fill("Không được tạo lặp");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  api.failPost = true;
  await dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Không lưu được dữ liệu thử nghiệm");
  await expect(dialog).toContainText("Không được tạo lặp");
  api.failPost = false; api.failRefresh = true;
  await dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" }).click();
  await expect(dialog.getByRole("status")).toContainText("Đã tạo thú cưng");
  await expect(dialog.getByRole("alert")).toContainText("Chưa tải lại được danh sách");
  await expect(dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" })).toHaveCount(0);
  api.failRefresh = false;
  await dialog.getByRole("button", { name: "Tải lại danh sách" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(api.posts).toHaveLength(2);
  expect(api.state.pets.filter(item => item.name === "Không được tạo lặp")).toHaveLength(1);
});

test("a pet creation with a lost response asks staff to inspect the list before creating again", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/admin/pets");
  await page.getByRole("button", { name: "Thêm thú cưng", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chủ nuôi", { exact: true }).selectOption("owner-a");
  await dialog.getByLabel("Tên thú cưng", { exact: true }).fill("Mất phản hồi");
  await dialog.getByRole("button", { name: "Kiểm tra thông tin" }).click();
  api.losePetResponse = true;
  await dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Chưa xác định yêu cầu đã được lưu");
  await expect(dialog.getByRole("button", { name: "Xác nhận thêm thú cưng" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Tải và kiểm tra danh sách" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("tbody tr").filter({ hasText: "Mất phản hồi" })).toBeVisible();
  expect(api.posts).toHaveLength(1);
});
