import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../dist/src/app.js";
import { signToken } from "../dist/src/lib/token.js";
import { BookingLifecycleService } from "../dist/src/application/services/bookingLifecycle.js";
import { PrismaBookingLifecycleStore } from "../dist/src/infrastructure/persistence/bookingLifecycleRepository.js";
const url = new URL(process.env.PG_TEST_DATABASE_URL || "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname.endsWith("_test"));
process.env.JWT_SECRET = randomBytes(32).toString("hex");
const db = new PrismaClient({ datasources: { db: { url: url.href } } });
let server, base, pet, owner, staff, admin, count = 0;
const users = [], ids = [];
async function start() { server = createApp(db).listen(0,"127.0.0.1"); await new Promise(r=>server.once("listening",r)); base=`http://127.0.0.1:${server.address().port}/api`; }
async function stop() { if(server) await new Promise(r=>server.close(r)); }
async function req(path, actor=staff, method="GET", body) {
  const res=await fetch(base+path,{method,headers:{"Content-Type":"application/json",...(actor?{Authorization:`Bearer ${signToken(actor.id,actor.role)}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,body:await res.json()};
}
const route = b => `/${"appointmentDate" in b || "serviceName" in b ? "appointments" : "hotel-bookings"}/${b.id}`;
async function fixture(kind="appointment", status="pending") {
  count++;
  const b=kind==="appointment"? await db.appointment.create({data:{ownerId:owner.id,petId:pet.id,type:"spa_bath",serviceName:"Lifecycle test",clinicName:"Test",appointmentDate:new Date(`2038-01-${String(count).padStart(2,"0")}`),appointmentTime:"10:00",status}})
    :await db.hotelBooking.create({data:{ownerId:owner.id,petId:pet.id,checkIn:new Date("2038-02-01"),checkOut:new Date("2038-02-02"),nights:1,roomType:"standard",serviceKeys:[],totalAmount:350000,status}});
  ids.push(b.id); return b;
}
async function change(b,status) { const res=await req(route(b)+"/status",staff,"PATCH",{status,expectedRevision:b.statusRevision}); assert.equal(res.status,200,JSON.stringify(res.body));return res.body.appointment||res.body.booking; }
async function advance(b,statuses) { for(const status of statuses)b=await change(b,status);return b; }
const undo=(b,actor=staff,extra={})=>req(route(b)+"/undo-status",actor,"POST",{reason:"Selected wrong pet",expectedRevision:b.statusRevision,...extra});
const history=b=>req(route(b)+"/status-history");
try {
  for(const role of ["owner","staff","admin"])users.push(await db.user.create({data:{role,fullName:`Lifecycle ${role}`,email:`${randomUUID()}@example.test`,passwordHash:"unused",passwordSalt:"unused"}}));
  [owner,staff,admin]=users;pet=await db.pet.create({data:{ownerId:owner.id,name:"Lifecycle pet",species:"dog",allergies:[]}});
  await start();
  for(const kind of ["appointment","hotel"]) {
    let b=await fixture(kind);const checkin=kind==="appointment"?"checked_in":"in_stay";
    assert.equal((await req(route(b)+"/status",staff,"PATCH",{status:checkin,expectedRevision:0})).status,409,"Cannot skip confirmation");
    assert.equal((await req(route(b)+"/status",staff,"PATCH",{status:"confirmed"})).status,422,"Requires revision");
    assert.equal((await req(route(b)+"/status-history",owner)).status,403);
    assert.equal((await req(route(b)+"/status-history",null)).status,401);
    b=await change(b,"confirmed");
    const race=await Promise.all(Array.from({length:6},()=>req(route(b)+"/status",staff,"PATCH",{status:checkin,expectedRevision:b.statusRevision})));
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409,409,409,409,409]);
    b=race.find(r=>r.status===200).body[kind==="appointment"?"appointment":"booking"];
    const firstHistory=(await history(b)).body;
    assert.equal(firstHistory.length,2); assert.equal(firstHistory[0].actorName,"Lifecycle staff");
    assert.equal((await undo(b,owner)).status,403);
    assert.equal((await undo(b,staff,{reason:" "})).status,422);
    const reversals=await Promise.all([undo(b),undo(b)]);
    assert.deepEqual(reversals.map(r=>r.status).sort(),[200,409]);
    b=reversals.find(r=>r.status===200).body[kind==="appointment"?"appointment":"booking"];
    assert.equal(b.status,"confirmed");
    const log=(await history(b)).body;
    assert.equal(log.length,3); assert.equal(log[0].reversesId,firstHistory[0].id); assert.equal(log[1].id,firstHistory[0].id);
    assert.equal(log[0].reason,"Selected wrong pet");
    await stop();await start(); assert.deepEqual((await history(b)).body,log,"Audit survives API restart");
    b=await change(b,checkin);
    if(kind==="appointment") { b=await change(b,"in_progress");assert.equal((await undo(b)).status,409); }
    b=await change(b,kind==="appointment"?"completed":"checked_out");
    assert.equal((await undo(b)).status,403,"Only admin reopens completion");
    const reopened=await undo(b,admin);assert.equal(reopened.status,200);assert.equal(reopened.body[kind==="appointment"?"appointment":"booking"].status,kind==="appointment"?"in_progress":"in_stay");
  }
  // Real transaction rollback: both status and audit disappear if notification writing fails.
  const rollback=await advance(await fixture(),["confirmed","checked_in"]);
  const store=new PrismaBookingLifecycleStore(db);
  const broken=new BookingLifecycleService({history:store.history.bind(store),run:(kind,id,work)=>store.run(kind,id,tx=>work({...tx,notify:async()=>{throw new Error("synthetic notification failure");}}))});
  const before=(await history(rollback)).body;
  await assert.rejects(broken.undo({sub:staff.id,role:staff.role},"appointment",rollback.id,{reason:"Mistake",expectedRevision:rollback.statusRevision}),/synthetic notification failure/);
  assert.equal((await db.appointment.findUniqueOrThrow({where:{id:rollback.id}})).status,"checked_in");
  assert.deepEqual((await history(rollback)).body,before);
  // Medical record vs undo: a shared booking lock prevents an inconsistent history.
  const medical=await advance(await fixture(),["confirmed","checked_in"]);
  const medicalRace=await Promise.all([req("/medical-records",staff,"POST",{petId:pet.id,appointmentId:medical.id,doctorName:"Test",visitDate:"2038-01-01",title:"Test",diagnosis:"Test",treatment:"Test"}),undo(medical)]);
  assert.ok((medicalRace[0].status===201&&medicalRace[1].status===409)||(medicalRace[0].status===409&&medicalRace[1].status===200));
  const medicalState=await db.appointment.findUniqueOrThrow({where:{id:medical.id}});
  assert.equal(await db.medicalRecord.count({where:{appointmentId:medical.id}}),medicalState.status==="completed"?1:0);
  const stay=await advance(await fixture("hotel"),["confirmed","in_stay"]);
  const careRace=await Promise.all([req(route(stay)+"/care-notes",staff,"POST",{note:"Care already performed"}),undo(stay)]);
  assert.ok((careRace[0].status===201&&careRace[1].status===409)||(careRace[0].status===409&&careRace[1].status===200));
  const stayState=await db.hotelBooking.findUniqueOrThrow({where:{id:stay.id}});
  assert.equal(await db.dailyCareNote.count({where:{bookingId:stay.id}}),stayState.status==="in_stay"?1:0);
  const careBlock=await advance(await fixture("hotel"),["confirmed","in_stay"]);
  assert.equal((await req(route(careBlock)+"/care-notes",staff,"POST",{note:"Fed"})).status,201);
  assert.equal((await undo(careBlock)).status,409);
  const checkout=await change(careBlock,"checked_out"); assert.equal((await undo(checkout,admin)).status,200,"Care history is retained when reopening checkout");
  // Invoice vs reopening: source row is locked by both operations.
  const bill=await advance(await fixture(),["confirmed","checked_in","in_progress","completed"]);
  const billRace=await Promise.all([req("/invoices/checkout",owner,"POST",{type:"appointment",relatedId:bill.id}),undo(bill,admin)]);
  assert.deepEqual(billRace.map(r=>r.status).sort(),[200,409]);
  const billed=await db.invoice.findFirst({where:{appointmentId:bill.id}});
  assert.equal((await db.appointment.findUniqueOrThrow({where:{id:bill.id}})).status,billed?"completed":"in_progress");
  if(billed) assert.equal((await undo(bill,admin)).status,409);
  const legacy=await fixture("appointment","checked_in");assert.equal((await undo(legacy)).status,409,"No invented pre-migration history");
  assert.equal((await req(route(legacy)+"/cancel",owner,"PATCH",{expectedRevision:0})).status,409);
  console.log("Booking lifecycle integration PASS: appointment/hotel confirmation, original+reversal audit, staff/admin/owner authorization, stale revisions and concurrent commands, persistence, notification rollback, medical/care/invoice races, legacy guard.");
} finally {
  await stop();
  if(ids.length) {
    await db.bookingStatusEvent.deleteMany({where:{bookingId:{in:ids},reversesId:{not:null}}});
    await db.bookingStatusEvent.deleteMany({where:{bookingId:{in:ids}}});
    await db.invoice.deleteMany({where:{ownerId:owner?.id}});
    await db.medicalRecord.deleteMany({where:{ownerId:owner?.id}});
    await db.notification.deleteMany({where:{OR:[{relatedAppointmentId:{in:ids}},{relatedBookingId:{in:ids}}]}});
  }
  if(users.length)await db.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});
  await db.$disconnect();
}
