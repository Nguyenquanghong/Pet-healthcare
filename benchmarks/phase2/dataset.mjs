// Synthetic read/load fixture only, called AFTER E2E project/DB/marker guards.
// Never imports application .env or accepts a target database URL.
import { randomUUID } from 'node:crypto';
export async function createDataset(db, { run, hash, count, anchor }) {
  if (!Number.isInteger(count) || count < 2 || count > 40) throw new Error('LOAD_ACCOUNT_COUNT_OUT_OF_BOUNDS');
  const accounts = [], day = offset => new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate()+offset));
  for(let n=0;n<count;n++){
    const owner=await db.core.user.create({data:{id:randomUUID(),role:'owner',fullName:`Load ${run.slice(0,8)} ${n}`,email:`load-${run}-${n}@example.test`,...hash}});
    const pets=Array.from({length:21},(_,i)=>({id:randomUUID(),ownerId:owner.id,name:`Load pet ${n}-${i}`,species:i%2?'cat':'dog',allergies:[]}));
    await db.core.pet.createMany({data:pets});
    const appointments=Array.from({length:120},(_,i)=>({id:randomUUID(),ownerId:owner.id,petId:pets[i%21].id,type:i%2?'spa_bath':'general_checkup',serviceName:'Synthetic load history',clinicName:'Synthetic clinic',appointmentDate:day(-180+i),appointmentTime:'09:00',status:i%3?'completed':'cancelled',statusRevision:0,createdBy:'owner'}));
    await db.clinic.appointment.createMany({data:appointments});
    await db.clinic.medicalRecord.createMany({data:appointments.filter(a=>a.status==='completed'&&a.type==='general_checkup').slice(0,30).map(a=>({id:randomUUID(),ownerId:owner.id,petId:a.petId,appointmentId:a.id,doctorName:'Synthetic doctor',visitDate:a.appointmentDate,title:'Synthetic record',diagnosis:'Fixture only',treatment:'Fixture only',internalNote:'Staff-only fixture'}))});
    const hotels=Array.from({length:30},(_,i)=>({id:randomUUID(),ownerId:owner.id,petId:pets[i%21].id,checkIn:day(90+i*3),checkOut:day(91+i*3),nights:1,roomType:'standard',serviceKeys:[],totalAmount:150000,status:'confirmed'}));
    await db.core.hotelBooking.createMany({data:hotels});
    await db.core.invoice.createMany({data:hotels.map((h,i)=>({id:randomUUID(),invoiceCode:`LOAD-${run}-${n}-${i}`,type:'hotel',ownerId:owner.id,petId:h.petId,hotelBookingId:h.id,subtotal:150000,totalAmount:150000,paymentStatus:'unpaid'}))});
    accounts.push({id:owner.id,email:owner.email,pets:pets.map(p=>({id:p.id,name:p.name}))});
  }
  return {accounts,description:{version:'multi-owner-v1',accounts:count,pets:count*21,appointments:count*120,medicalRecords:count*30,hotelBookings:count*30,invoices:count*30,anchor:anchor.toISOString(),synthetic:true,notes:'Historical clinical rows and future unpaid hotel invoices; no payment traffic. UUID rows appended, never reset.'}};
}
