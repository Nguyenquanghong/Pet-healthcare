// PCN phase-1 fixture shape, written only after stack.mjs validates its fresh DBs.
import {randomUUID} from 'node:crypto';
export async function createPcnDataset(db,{run,hash,count}){
  if(!Number.isInteger(count)||count<2||count>100)throw new Error('PCN_ACCOUNT_COUNT_OUT_OF_BOUNDS');
  const accounts=[];
  for(let i=0;i<count;i++){
    const owner=await db.core.user.create({data:{id:randomUUID(),email:`load-${run}-${i}@example.test`,fullName:`Synthetic owner ${i}`,role:'owner',...hash}});
    const pet=await db.core.pet.create({data:{id:randomUUID(),ownerId:owner.id,name:`Synthetic pet ${i}`,species:'dog',allergies:[],qrEnabled:true,qrToken:`load-${run}-${i}`}});
    await db.clinic.appointment.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,type:'general_checkup',serviceName:'Synthetic existing visit',clinicName:'Synthetic clinic',appointmentDate:new Date('2098-01-01'),appointmentTime:'09:00'}});
    await db.clinic.medicalRecord.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,doctorName:'Synthetic doctor',visitDate:new Date('2026-01-01'),title:'Synthetic record',diagnosis:'Synthetic diagnosis',treatment:'Synthetic treatment'}});
    await db.notification.notification.create({data:{id:randomUUID(),recipientOwnerId:owner.id,recipientRole:'owner',type:'pcn_fixture',title:'Synthetic private notice',message:'Synthetic message'}});
    const hotel=await db.core.hotelBooking.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,checkIn:new Date('2098-02-01'),checkOut:new Date('2098-02-02'),roomType:'standard',status:'confirmed',serviceKeys:[],nights:1,totalAmount:200000}});
    await db.core.invoice.create({data:{id:randomUUID(),invoiceCode:`PCN-${pet.id}`,type:'hotel_booking',ownerId:owner.id,petId:pet.id,hotelBookingId:hotel.id,subtotal:200000,totalAmount:200000,paymentStatus:'unpaid',items:{create:{description:'Synthetic one-night stay',unitPrice:200000,quantity:1,amount:200000}}}});
    accounts.push({id:owner.id,email:owner.email,pets:[{id:pet.id,name:pet.name,qrToken:pet.qrToken}]});
  }
  return{accounts,description:{version:'phase1-pcn-shape-v1',accounts:count,pets:count,appointments:count,medicalRecords:count,hotelBookings:count,invoices:count,notifications:count,synthetic:true,notes:'One pet and one row per read resource per owner, as phase-1 PCN; split databases and RS256 differ. Setup admin is additional; browser-only doctor fixture omitted.'}};
}
