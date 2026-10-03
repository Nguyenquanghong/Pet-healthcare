import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";

const url = process.env.PG_TEST_DATABASE_URL;
assert.ok(url, "Use a disposable migrated PG_TEST_DATABASE_URL.");
const parsed = new URL(url);
assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname)); assert.match(parsed.pathname, /_test$/);
process.env.JWT_SECRET = randomBytes(32).toString("hex");
const db = new PrismaClient({ datasources: { db: { url } } });
const marker = "page-" + randomUUID(), users = [], notificationIds = [];
let server;
try {
  for (const role of ["owner", "owner", "admin"]) users.push(await db.user.create({ data: { role, fullName: marker, passwordHash: "secret", passwordSalt: "secret" } }));
  const [owner, other, staff] = users;
  const pets = Array.from({ length: 45 }, (_, index) => ({ id: randomUUID(), ownerId: owner.id, name: index === 44 ? marker + " needle Alley" : marker + " " + index, species: index % 2 ? "cat" : "dog", allergies: [], createdAt: new Date("2097-01-01") }));
  await db.pet.createMany({ data: pets });
  await db.pet.create({ data: { ownerId: other.id, name: marker + " outsider", species: "cat", allergies: [] } });
  const petId = pets[0].id;
  const appointments = [];
  for (let index = 0; index < 31; index++) appointments.push(await db.appointment.create({ data: { petId, ownerId: owner.id, type: "spa_bath", serviceName: marker + index, clinicName: "Test", appointmentDate: new Date("2097-06-02"), appointmentTime: `09:${String(index).padStart(2,"0")}`, status: index === 30 ? "completed" : "pending", internalNote: "STAFF_ONLY" } }));
  for (let index = 0; index < 24; index++) await db.medicalRecord.create({ data: { petId, ownerId: owner.id, title: marker + index, diagnosis: "Healthy", treatment: "Observe", doctorName: "Test", visitDate: new Date("2097-06-02"), internalNote: "STAFF_ONLY", appointmentId: appointments[0].id } });
  const booking = await db.hotelBooking.create({ data: { petId, ownerId: owner.id, checkIn: new Date("2097-06-01"), checkOut: new Date("2097-06-02"), nights: 1, roomType: "standard", totalAmount: 350000, status: "in_stay", serviceKeys: [], internalNote: "STAFF_ONLY" } });
  for (let index = 0; index < 23; index++) await db.dailyCareNote.create({ data: { bookingId: booking.id, noteDate: new Date("2097-06-01"), note: marker, visibleToOwner: index !== 22 } });
  await db.medicalImage.createMany({ data: Array.from({ length: 21 }, () => ({ petId, title: marker, imageUrl: "data:image/png;base64,AAAA", mimeType: "image/png" })) });
  for (let index = 0; index < 25; index++) notificationIds.push((await db.notification.create({ data: { recipientOwnerId: owner.id, title: marker, message: marker, type: "general" } })).id);
  notificationIds.push((await db.notification.create({ data: { recipientRole: "admin", title: marker, message: marker, type: "general" } })).id);
  await db.invoice.create({ data: { invoiceCode: marker, type: "hotel_booking", hotelBookingId: booking.id, ownerId: owner.id, petId, subtotal: 350000, totalAmount: 350000, paymentStatus: "paid", paidAt: new Date("2097-05-31T17:00:00Z"), issuedAt: new Date("2097-05-01") } });
  server = createApp(db).listen(0,"127.0.0.1"); await new Promise(resolve => server.once("listening",resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`, ownerToken=signToken(owner.id,"owner"), staffToken=signToken(staff.id,"admin"), otherToken=signToken(other.id,"owner");
  async function get(path, token=ownerToken, status=200) { const response=await fetch(base+path,{headers:token?{authorization:`Bearer ${token}`}:{}});const data=await response.json();assert.equal(response.status,status,`${path}: ${JSON.stringify(data)}`);return data; }
  const first=await get("/pets"), second=await get("/pets?page=2"), third=await get("/pets?page=3");
  assert.equal(first.items.length,20);assert.equal(second.items.length,20);assert.equal(third.items.length,5);assert.equal(first.pagination.total,45);
  assert.equal(new Set([...first.items,...second.items,...third.items].map(row=>row.id)).size,45);
  assert.deepEqual((await get("/pets?page=2")).items.map(row=>row.id),second.items.map(row=>row.id));
  assert.equal((await get(`/pets?ownerId=${other.id}`)).pagination.total,45);
  assert.equal((await get("/pets?q=needle")).items[0].id,pets[44].id);
  assert.equal((await get("/pets?q=all")).pagination.total,1,"Literal search 'all' must not disable searching");
  assert.equal((await get("/pets?species=cat")).pagination.total,22);
  assert.equal((await get("/pets?page=99")).items.length,0);
  for(const query of ["page=0","page=1&page=2","pageSize=101","pageSize=1.5","species=invalid"]) await get("/pets?"+query,ownerToken,422);
  await get("/pets",null,401);await get("/owners",ownerToken,403);await get("/invoices/summary",ownerToken,403);
  const directory=await get(`/owners?q=${marker}`,staffToken);assert.equal(directory.items.find(row=>row.id===owner.id).petCount,45);
  assert.ok(directory.items.every(row=>!Object.hasOwn(row,"passwordHash")&&!Object.hasOwn(row,"passwordSalt")));
  for(const path of ["/appointments","/medical-records","/medical-records/images","/notifications","/hotel-care-notes?bookingId="+booking.id]) {
    const page=await get(path);assert.equal(page.items.length,20);assert.ok(page.pagination.total>20);assert.ok(page.items.every(row=>!Object.hasOwn(row,"internalNote")));
    const hidden=await get(path,otherToken);assert.equal(hidden.pagination.total,0);assert.equal(hidden.related.pets.length,0);
  }
  const medical=await get("/medical-records?page=2");assert.equal(medical.items.length,4);assert.equal(medical.related.appointments[0].id,appointments[0].id);assert.equal(medical.related.appointments[0].internalNote,undefined);
  const statusPage=await get("/appointments?status=pending&page=2");assert.equal(statusPage.items.length,10);assert.equal(statusPage.counts.pending,30);assert.equal(statusPage.counts.completed,1);
  assert.equal((await get("/appointments?mode=unbilled")).items[0].id,appointments[30].id);
  assert.equal((await get("/hotel-bookings?mode=unbilled")).pagination.total,0,"Already invoiced booking must never be offered as a source");
  assert.equal((await get("/appointments/calendar?month=2097-06&category=spa"))["2097-06-02"],31);
  assert.deepEqual(await get("/appointments/calendar?month=2097-06&category=spa",otherToken),{});
  const session=await get("/bootstrap");assert.equal(session.pets.length,20);assert.equal(session.appointments.length,0);assert.equal(session.medicalImages.length,0);assert.equal(session.summary.totals.pets,45);assert.equal(session.summary.unread,25);
  const adminSession=await get("/bootstrap",staffToken);assert.equal(adminSession.owners.length,0);assert.equal(adminSession.pets.length,0);
  const dashboard=await get("/bootstrap?view=dashboard");assert.equal(dashboard.summary.totals.appointments,31);assert.ok(dashboard.pets.length<=20);assert.ok(dashboard.appointments.length<=5);assert.ok(dashboard.notifications.length<=5);
  await get("/bootstrap?view=all",ownerToken,422);
  const figures=await get("/invoices/summary?month=2097-06",staffToken);assert.equal(figures.received,350000);assert.equal(figures.paidCount,1);assert.equal(figures.hotel,350000);
  const notes=await get(`/hotel-care-notes?bookingId=${booking.id}&page=2`);assert.equal(notes.pagination.total,22);assert.equal(notes.items.length,2);
  console.log("Pagination PostgreSQL PASS: nine scoped collections, stable 20/20/5 pages, database filtering/totals, privacy, bounded bootstrap, unbilled source exclusion, month calendar and UTC+7 billing aggregate.");
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.notification.deleteMany({where:{id:{in:notificationIds}}});
  await db.invoice.deleteMany({where:{ownerId:{in:users.map(user=>user.id)}}});
  await db.user.deleteMany({where:{id:{in:users.map(user=>user.id)}}});
  await db.$disconnect();
}
