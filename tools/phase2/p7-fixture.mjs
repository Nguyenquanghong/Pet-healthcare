import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {assertDatabase,client} from './p7-environment.mjs';
import {hashPasswordAsync} from '../../backend/dist/src/lib/password.js';

export async function legacyFixture(ctx){
  const db=client(ctx,'legacy'),password='P7-fixture-only-2026!',date=new Date('2026-01-01T00:00:00.000Z'),later=new Date('2026-01-02T00:00:00.000Z');
  try{
    await assertDatabase(db,ctx,'legacy');const hash=await hashPasswordAsync(password),users={};
    for(const name of ['owner','other','admin','doctor','counter'])users[name]=await db.user.create({data:{id:randomUUID(),fullName:'P7 synthetic '+name,role:['admin','doctor'].includes(name)?name:'owner',...(name==='admin'||name==='doctor'?{username:'p7_'+name+'_'+ctx.run.slice(0,8)}:name!=='counter'?{email:'p7_'+name+'_'+ctx.run.slice(0,8)+'@example.test'}:{}),...(name==='counter'?{passwordHash:'',passwordSalt:''}:hash),phone:'p7-'+randomUUID(),createdAt:date,updatedAt:date}});
    const pet=await db.pet.create({data:{id:randomUUID(),ownerId:users.owner.id,name:'P7 archived pet',species:'dog',weightKg:'12.34',allergies:['synthetic'],notes:'Synthetic only',microchipId:'p7-'+randomUUID(),createdAt:date,updatedAt:date}});
    const otherPet=await db.pet.create({data:{ownerId:users.other.id,name:'P7 other private pet',species:'cat',allergies:[],createdAt:date,updatedAt:date}});
    const counterPet=await db.pet.create({data:{ownerId:users.counter.id,name:'P7 counter pet',species:'rabbit',allergies:[],createdAt:date,updatedAt:date}});
    await db.user.update({where:{id:users.owner.id},data:{address:'Synthetic changed address',updatedAt:date}});
    await db.pet.update({where:{id:pet.id},data:{breed:'Synthetic updated breed',updatedAt:date}});
    const types=['general_checkup','vaccination','dental','dermatology','surgery','hotel_consultation','spa_bath','spa_grooming','spa_combo','other'],appointments=[];
    for(let n=0;n<types.length;n++){
      const status=n===0||n===6?'completed':['pending','confirmed','checked_in','in_progress','cancelled','no_show'][n%6];
      const a=await db.appointment.create({data:{id:randomUUID(),ownerId:users.owner.id,petId:pet.id,doctorId:users.doctor.id,type:types[n],serviceName:'P7 legacy '+types[n],clinicName:'Synthetic clinic',appointmentDate:new Date('2026-01-01T00:00:00Z'),appointmentTime:String(n+8).padStart(2,'0')+':00',status,statusRevision:1,ownerNote:'Synthetic owner note',internalNote:'P7 hidden medical context',createdBy:'staff',createdAt:date,updatedAt:date}});appointments.push(a);
      await db.bookingStatusEvent.create({data:{kind:'appointment',bookingId:a.id,revision:1,action:'transition',fromStatus:'pending',toStatus:status,actorId:users.admin.id,actorName:users.admin.fullName,actorRole:'admin',createdAt:date}});
    }
    const reverse=appointments[1],original=await db.bookingStatusEvent.findFirstOrThrow({where:{bookingId:reverse.id}});
    await db.bookingStatusEvent.create({data:{kind:'appointment',bookingId:reverse.id,revision:2,action:'undo',fromStatus:reverse.status,toStatus:'pending',actorId:users.admin.id,actorName:users.admin.fullName,actorRole:'admin',reversesId:original.id,reason:'Synthetic reversal',createdAt:date}});
    await db.appointment.update({where:{id:reverse.id},data:{status:'pending',statusRevision:2,updatedAt:date}});
    const medical=await db.medicalRecord.create({data:{ownerId:users.owner.id,petId:pet.id,appointmentId:appointments[0].id,doctorName:users.doctor.fullName,title:'Archived synthetic visit',visitDate:new Date('2026-01-01T00:00:00Z'),diagnosis:'Synthetic',treatment:'Synthetic',weightKg:'12.34',temperatureC:'38.5',internalNote:'P7 hidden record',createdAt:date,updatedAt:date}});
    const image=await db.medicalImage.create({data:{petId:pet.id,title:'Archived synthetic image',imageUrl:'data:image/png;base64,cDc=',mimeType:'image/png',createdAt:date}});
    const hotel=await db.hotelBooking.create({data:{ownerId:users.owner.id,petId:pet.id,checkIn:new Date('2026-01-01T00:00:00Z'),checkOut:new Date('2026-01-03T00:00:00Z'),nights:2,roomType:'standard',serviceKeys:['bath'],totalAmount:'400000',status:'checked_out',statusRevision:1,createdAt:date,updatedAt:date}});
    await db.hotelBookingRequest.create({data:{actorId:users.owner.id,requestKey:randomUUID(),fingerprint:'p7-fixture',bookingId:hotel.id,createdAt:date}});
    await db.bookingStatusEvent.create({data:{kind:'hotel',bookingId:hotel.id,revision:1,action:'transition',fromStatus:'in_stay',toStatus:'checked_out',actorId:users.admin.id,actorName:users.admin.fullName,actorRole:'admin',createdAt:date}});
    await db.dailyCareNote.create({data:{bookingId:hotel.id,noteDate:new Date('2026-01-02T00:00:00Z'),note:'Synthetic care',visibleToOwner:false,createdByStaffId:users.admin.id,createdAt:date}});
    const invoices=[];
    for(const [index,source]of [appointments[0],appointments[6],hotel].entries()){
      const total=index===2?400000:index===1?30000:123450,paid=index===0;
      const invoice=await db.invoice.create({data:{invoiceCode:'P7-'+randomUUID(),transferCode:'NIPO'+String(9000+index).padStart(10,'0'),type:index===2?'hotel_booking':'appointment',ownerId:users.owner.id,petId:pet.id,...(index===2?{hotelBookingId:source.id}:{appointmentId:source.id}),subtotal:total,taxAmount:0,discountAmount:0,totalAmount:total,paymentStatus:paid?'paid':'unpaid',paymentMethod:paid?'cash':null,paidAt:paid?later:null,bankTransferDetails:index===1?{synthetic:true}:undefined,issuedAt:later,createdAt:later,updatedAt:later,items:{create:{description:'Synthetic legacy line',unitPrice:total,quantity:1,amount:total}}}});invoices.push(invoice);
      await db.paymentAttempt.create({data:{id:randomUUID(),invoiceId:invoice.id,amount:total,status:paid?'succeeded':'pending',expiresAt:new Date('2026-01-04T00:00:00Z'),createdAt:later}});
      if(paid)await db.paymentEvent.create({data:{invoiceId:invoice.id,action:'cash',fromStatus:'unpaid',toStatus:'paid',actorId:users.admin.id,actorName:users.admin.fullName,actorRole:'admin',createdAt:later}});
    }
    // Preserve actual JSON null distinctly from SQL NULL through export/import.
    await db.$executeRaw`UPDATE runtime.invoices SET bank_transfer_details='null'::jsonb WHERE id=${invoices[2].id}`;
    const activationToken=randomBytes(32).toString('base64url'),activation=await db.ownerActivation.create({data:{ownerId:users.counter.id,tokenHash:createHash('sha256').update(activationToken).digest('hex'),email:'p7_counter_'+ctx.run.slice(0,8)+'@example.test',expiresAt:new Date(Date.now()+86400000),issuedBy:users.admin.id,issuedByName:users.admin.fullName,createdAt:date}});
    await db.rescueReport.create({data:{petId:pet.id,finderPhone:'synthetic-only',location:'Synthetic fixture',createdAt:date}});
    const notifications=[];for(const status of ['sent','read'])notifications.push(await db.notification.create({data:{recipientOwnerId:users.owner.id,recipientRole:'owner',type:'general',title:'P7 archived '+status,message:'Synthetic message',status,relatedPetId:pet.id,createdAt:date,sentAt:later}}));
    const evidence={notificationEvents:{}},events=[];
    for(const [resolution,notificationId]of [['materialized',notifications[1].id],['deleted',randomUUID()],['pending',randomUUID()]]){
      const id=randomUUID(),event={eventId:id,eventType:'notification.requested.v1',schemaVersion:1,producer:'core',aggregateType:'notification',aggregateId:notificationId,aggregateVersion:1,occurredAt:date.toISOString(),correlationId:randomUUID(),payload:{notificationId,recipientOwnerId:users.owner.id,recipientRole:'owner',type:'general',title:resolution==='materialized'?notifications[1].title:'P7 '+resolution,message:'Synthetic message',relatedPetId:pet.id,status:'sent',createdAt:date.toISOString(),sentAt:later.toISOString()}};
      await db.outboxEvent.create({data:{id,envelope:event,createdAt:date,nextAttemptAt:date}});evidence.notificationEvents[id]=resolution;events.push(event);
    }
    return {users,pet,otherPet,counterPet,appointments,medical,image,hotel,invoices,activation,activationToken,notifications,evidence,events,password};
  }finally{await db.$disconnect();}
}
