import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

for (const kind of ["appointment", "hotel"] as const) test(`${kind}: confirm identity, recover failures, undo and retain history`, async ({ page, request, baseURL }) => {
  expect(["localhost","127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  const api=process.env.API_BASE_URL!;
  expect(["localhost","127.0.0.1"]).toContain(new URL(api).hostname);
  const ownerLogin=await request.post(`${api}/auth/owner/login`,{data:{email:"owner@example.com",password:"owner123"}});
  expect(ownerLogin.status()).toBe(200);
  const ownerData=await ownerLogin.json(), ownerHeaders={authorization:`Bearer ${ownerData.token}`};
  const adminLogin=await request.post(`${api}/auth/admin/login`,{data:{username:"admin",password:"admin123"}});
  expect(adminLogin.status()).toBe(200);
  const adminData=await adminLogin.json(), headers={authorization:`Bearer ${adminData.token}`};
  const name=`Undo ${kind} ${randomUUID().slice(0,8)}`;
  const petResult=await request.post(`${api}/pets`,{headers:ownerHeaders,data:{name,species:"dog"}});
  expect(petResult.status()).toBe(201); const {pet}=await petResult.json();
  const collection=kind==="appointment"?"appointments":"hotel-bookings";
  const source=await request.post(`${api}/${collection}`,{headers:ownerHeaders,data:kind==="appointment"
    ?{petId:pet.id,type:"spa_bath",serviceName:name,date:"2039-01-01",time:"10:00"}
    :{petId:pet.id,checkIn:"2039-01-01",checkOut:"2039-01-02",roomType:"standard",serviceKeys:[]}});
  expect(source.status()).toBe(201); const created=await source.json(); const booking=created.appointment||created.booking;
  const path=`${api}/${collection}/${booking.id}`;
  expect((await request.patch(path+"/status",{headers,data:{status:"confirmed",expectedRevision:0}})).status()).toBe(200);
  await page.addInitScript(token=>sessionStorage.setItem("nipopeto_access_token",token),adminData.token);
  await page.goto(`/admin/${collection}`);
  const card=kind==="appointment"?page.getByRole("row").filter({hasText:name}):page.getByTestId(`hotel-booking-${booking.id}`);
  const checkin=card.getByRole("button",{name:kind==="appointment"?"Check-in":"Check-in pet",exact:true});
  await checkin.click();
  let dialog=page.getByRole("dialog",{name:"Xác nhận đã nhận thú cưng",exact:true});
  await expect(dialog).toContainText(name);await expect(dialog).toContainText(booking.id);await expect(dialog).toContainText(ownerData.user.fullName);
  await dialog.getByRole("button",{name:"Đóng",exact:true}).click();
  await expect(checkin).toBeVisible();
  await checkin.click();
  await page.route(`**/api/${collection}/${booking.id}/status`,route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Lỗi kiểm thử khi xác nhận"})}));
  await dialog.getByRole("button",{name:"Xác nhận đã nhận thú cưng",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("Lỗi kiểm thử");
  await expect(card).toContainText("Đã xác nhận");
  await page.unroute(`**/api/${collection}/${booking.id}/status`);
  // Another employee changes this booking after the confirmation dialog opened.
  expect((await request.patch(path+"/status",{headers,data:{status:"confirmed",internalNote:"Concurrent staff update",expectedRevision:1}})).status()).toBe(200);
  await dialog.getByRole("button",{name:"Xác nhận đã nhận thú cưng",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("vừa được cập nhật");
  await dialog.getByRole("button",{name:"Đóng",exact:true}).click();await page.reload();
  await checkin.click();
  if(process.env.BILLING_SCREENSHOT) await page.screenshot({path:process.env.BILLING_SCREENSHOT.replace("billing.png",`${kind}-checkin-confirm.png`)});
  await dialog.getByRole("button",{name:"Xác nhận đã nhận thú cưng",exact:true}).click();await expect(dialog).toHaveCount(0);
  await card.getByRole("button",{name:"Hoàn tác check-in",exact:true}).click();
  dialog=page.getByRole("dialog",{name:"Hoàn tác check-in",exact:true});
  await expect(dialog.getByRole("button",{name:"Xác nhận hoàn tác",exact:true})).toBeDisabled();
  await dialog.getByLabel("Lý do hoàn tác").fill("Chọn nhầm thú cưng khi nhận khách");
  await dialog.getByRole("button",{name:"Xác nhận hoàn tác",exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(checkin).toBeVisible();await page.reload();await expect(checkin).toBeVisible();
  await card.getByRole("button",{name:"Lịch sử thao tác",exact:true}).click();
  dialog=page.getByRole("dialog",{name:"Lịch sử thao tác",exact:true});
  await expect(dialog).toContainText("Chọn nhầm thú cưng khi nhận khách");
  await expect(dialog).toContainText("Thao tác này đã được hoàn tác");
  if(process.env.BILLING_SCREENSHOT) await page.screenshot({path:process.env.BILLING_SCREENSHOT.replace("billing.png",`${kind}-history.png`)});
  await dialog.getByRole("button",{name:"Đóng",exact:true}).click();
  await checkin.click();dialog=page.getByRole("dialog",{name:"Xác nhận đã nhận thú cưng",exact:true});
  await dialog.getByRole("button",{name:"Xác nhận đã nhận thú cưng",exact:true}).click();await expect(dialog).toHaveCount(0);
  if(kind==="appointment") {
    await card.getByRole("button",{name:"Bắt đầu Spa",exact:true}).click();
    dialog=page.getByRole("dialog",{name:"Xác nhận: Đang thực hiện",exact:true});
    await dialog.getByRole("button",{name:"Xác nhận: Đang thực hiện",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(card.getByRole("button",{name:"Hoàn tác check-in",exact:true})).toHaveCount(0);
  } else {
    await card.getByRole("button",{name:"Cập nhật nhật ký",exact:true}).click();
    await page.getByPlaceholder(/Ví dụ: Bé Mochi/).fill("Test failed care write");
    await page.route(`**/api/hotel-bookings/${booking.id}/care-notes`,route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Nhật ký chưa được lưu"})}));
    await page.getByRole("button",{name:"Gửi nhật ký chăm sóc",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("Nhật ký chưa được lưu");
    await expect(page.getByPlaceholder(/Ví dụ: Bé Mochi/)).toHaveValue("Test failed care write");
    await page.getByRole("button",{name:"Hủy",exact:true}).click();
    await page.unroute(`**/api/hotel-bookings/${booking.id}/care-notes`);
  }
  const finish=async()=>{
    await card.getByRole("button",{name:kind==="appointment"?"Hoàn thành":"Check-out",exact:true}).click();
    const title=kind==="appointment"?"Xác nhận hoàn thành dịch vụ":"Xác nhận đã trả thú cưng";
    const finishDialog=page.getByRole("dialog",{name:title,exact:true});
    await expect(finishDialog).toContainText(name);
    await finishDialog.getByRole("button",{name:title,exact:true}).click();await expect(finishDialog).toHaveCount(0);
  };
  await finish();
  await card.getByRole("button",{name:"Mở lại dịch vụ",exact:true}).click();
  dialog=page.getByRole("dialog",{name:"Mở lại dịch vụ",exact:true});
  await dialog.getByLabel("Lý do hoàn tác").fill("Chưa bàn giao xong");
  await dialog.getByRole("button",{name:"Xác nhận hoàn tác",exact:true}).click();await expect(dialog).toHaveCount(0);
  await finish();
  expect((await request.post(`${api}/invoices/checkout`,{headers:ownerHeaders,data:{type:kind==="appointment"?"appointment":"hotel_booking",relatedId:booking.id}})).status()).toBe(200);
  await card.getByRole("button",{name:"Mở lại dịch vụ",exact:true}).click();
  dialog=page.getByRole("dialog",{name:"Mở lại dịch vụ",exact:true});
  await dialog.getByLabel("Lý do hoàn tác").fill("Kiểm tra điều kiện hóa đơn");
  await dialog.getByRole("button",{name:"Xác nhận hoàn tác",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("hóa đơn liên quan");
});
