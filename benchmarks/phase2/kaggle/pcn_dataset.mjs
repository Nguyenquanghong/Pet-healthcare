// PCN phase-1 fixture shape, written only after stack.mjs validates its fresh DBs.
import {randomUUID} from 'node:crypto';
// One existing visit per owner, each on its own 30-minute slot (P10: 08:00-17:00, 2 places per slot).
// One-night stay, at most 5 per night (AQ-10: 10 standard rooms per night).
export function existingStay(i){const day=Math.floor(i/5);return{checkIn:new Date(Date.UTC(2098,1,1+day)),checkOut:new Date(Date.UTC(2098,1,2+day))};}
export function existingVisit(i){const m=480+30*(i%19);return{appointmentDate:new Date(Date.UTC(2098,0,1+Math.floor(i/19))),appointmentTime:`${String(m/60|0).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`};}
export async function createPcnDataset(db,{run,hash,count}){
  if(!Number.isInteger(count)||count<2||count>100)throw new Error('PCN_ACCOUNT_COUNT_OUT_OF_BOUNDS');
  const accounts=[];
  for(let i=0;i<count;i++){
    const owner=await db.core.user.create({data:{id:randomUUID(),email:`load-${run}-${i}@example.test`,fullName:`Synthetic owner ${i}`,role:'owner',...hash}});
    const pet=await db.core.pet.create({data:{id:randomUUID(),ownerId:owner.id,name:`Synthetic pet ${i}`,species:'dog',allergies:[],qrEnabled:true,qrToken:`load-${run}-${i}`}});
    await db.clinic.appointment.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,type:'general_checkup',serviceName:'Synthetic existing visit',clinicName:'Synthetic clinic',...existingVisit(i)}});
    await db.clinic.medicalRecord.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,doctorName:'Synthetic doctor',visitDate:new Date('2026-01-01'),title:'Synthetic record',diagnosis:'Synthetic diagnosis',treatment:'Synthetic treatment'}});
    await db.notification.notification.create({data:{id:randomUUID(),recipientOwnerId:owner.id,recipientRole:'owner',type:'pcn_fixture',title:'Synthetic private notice',message:'Synthetic message'}});
    const hotel=await db.core.hotelBooking.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,...existingStay(i),roomType:'standard',status:'confirmed',serviceKeys:[],nights:1,totalAmount:200000}});
    await db.core.invoice.create({data:{id:randomUUID(),invoiceCode:`PCN-${pet.id}`,type:'hotel_booking',ownerId:owner.id,petId:pet.id,hotelBookingId:hotel.id,subtotal:200000,totalAmount:200000,paymentStatus:'unpaid',items:{create:{description:'Synthetic one-night stay',unitPrice:200000,quantity:1,amount:200000}}}});
    accounts.push({id:owner.id,email:owner.email,pets:[{id:pet.id,name:pet.name,qrToken:pet.qrToken}]});
  }
  return{accounts,description:{version:'phase1-pcn-shape-v1',accounts:count,pets:count,appointments:count,medicalRecords:count,hotelBookings:count,invoices:count,notifications:count,synthetic:true,notes:'One pet and one row per read resource per owner, as phase-1 PCN; split databases and RS256 differ. Setup admin is additional; browser-only doctor fixture omitted.'}};
}
