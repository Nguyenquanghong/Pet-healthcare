import { Prisma, type PrismaClient } from '../../generated/client/index.js';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import type { AppointmentRepository,AppointmentDependencies } from '../../application/ports/appointments.js';
import type { MedicalRecordRepository,MedicalDependencies,MedicalRevisionValue } from '../../application/ports/medicalRecords.js';
import type { BookingLifecycleStore,LifecycleTransaction,BookingKind } from '../../application/ports/bookingLifecycle.js';
import { appointmentSlotWrite } from './appointmentSlotConflict.js';
import { writeNotification } from '../../notificationOutbox.js';
import type { RequestDirectory } from '../../directory.js';
import {trackAppointmentChange} from '../../readRevision.js';
import type {BlobStore} from '../../blobStore.js';
import {imageRetentionMs} from '../../blobCleanup.js';

type Client=PrismaClient|Prisma.TransactionClient;
type ImageRow={id:string;petId:string;ownerId:string;storageKey:string|null;sha256:string|null;sizeBytes:number|null;deletedAt:Date|null};
const lockedImage=async(tx:Client,id:string)=>(await tx.$queryRaw<ImageRow[]>`SELECT id,pet_id AS "petId",owner_id AS "ownerId",storage_key AS "storageKey",sha256,size_bytes AS "sizeBytes",deleted_at AS "deletedAt" FROM medical_images WHERE id=${id} FOR UPDATE`)[0];
const imageLog=(image:ImageRow,action:'delete'|'restore',actor:Actor)=>({imageId:image.id,action,petId:image.petId,ownerId:image.ownerId,storageKey:image.storageKey,sha256:image.sha256,sizeBytes:image.sizeBytes,actorId:actor.sub,actorRole:actor.role});
const transaction=<T>(db:PrismaClient,bound:Prisma.TransactionClient|undefined,work:(tx:Prisma.TransactionClient)=>Promise<T>)=>bound?work(bound):db.$transaction(work);
async function unlocked(tx:Client,id:string){
  if(await tx.appointmentReservation.count({where:{appointmentId:id,state:{in:['HELD','INVOICED']}}}))throw new BusinessError(409,'Appointment is reserved or already invoiced.');
}
export async function appendStatusEvent(tx:Client,directory:RequestDirectory,id:string,actor:Actor,action:string,fromStatus:string,toStatus:string,revision:number,reason?:string,reversesId?:string){
  await tx.bookingStatusEvent.create({data:{kind:'appointment',bookingId:id,actorId:actor.sub,actorName:directory.snapshot.actor.fullName,actorRole:actor.role,action,fromStatus,toStatus,revision,reason,reversesId}});
}
class Appointments implements AppointmentRepository {
  constructor(private readonly db:Client,private readonly directory:RequestDirectory){}
  list(ownerId?:string){return this.db.appointment.findMany({where:{ownerId},orderBy:[{appointmentDate:'desc'},{appointmentTime:'desc'}]});}
  findPet(id:string){return this.directory.pet(id);}
  find(id:string){return this.db.appointment.findUnique({where:{id}});}
  async findWithPet(id:string){const appointment=await this.find(id);return appointment?{appointment,pet:await this.directory.pet(appointment.petId)}:null;}
  async hasSlot(petId:string,date:Date,time:string,exceptId?:string){return !!await this.db.appointment.findFirst({where:{petId,appointmentDate:date,appointmentTime:time,...(exceptId?{id:{not:exceptId}}:{}),status:{notIn:['cancelled','no_show']}}});}
  async create(data:Parameters<AppointmentRepository['create']>[0]){const row=await appointmentSlotWrite(this.db.appointment.create({data}));await trackAppointmentChange(this.db,row.id,{created:true});return row;}
}
const writer=(db:Client)=>({create:async(draft:{recipientOwnerId?:string;recipientRole:string;title:string;message:string;type:string;actionUrl:string;relatedPetId:string;relatedAppointmentId:string|null})=>{await writeNotification(db,{...draft,recipientOwnerId:draft.recipientOwnerId??null,recipientRole:draft.recipientRole as 'owner'|'admin'});}});
export function appointmentDependencies(db:PrismaClient,directory:RequestDirectory,bound?:Prisma.TransactionClient):AppointmentDependencies{
  const c=bound??db;return{appointments:new Appointments(c,directory),notifications:writer(c),unitOfWork:{run:work=>transaction(db,bound,tx=>work({appointments:new Appointments(tx,directory),notifications:writer(tx)}))}};
}
class Records implements MedicalRecordRepository {
  constructor(private readonly db:Client,private readonly directory:RequestDirectory){}
  list(ownerId?:string,petId?:string){return this.db.medicalRecord.findMany({where:{ownerId,petId},orderBy:{visitDate:'desc'}});}
  findPet(id:string){return this.directory.pet(id);}
  async findAppointment(id:string){await this.db.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;await unlocked(this.db,id);return this.db.appointment.findUnique({where:{id},select:{id:true,petId:true,ownerId:true}});}
  find(id:string){return this.db.medicalRecord.findUnique({where:{id}});}
  // AQ-15: callers run these inside the record's transaction (unit of work or
  // medicalMutation), so the revision commits or rolls back with the change.
  private revise(recordId:string,action:'create'|'update'|'delete',before:unknown,after:unknown,actor:Actor){
    // An omitted nullable Json column is SQL NULL; the DbNull sentinel is not
    // portable across separately generated clients.
    const snapshot=(v:unknown)=>v==null?undefined:JSON.parse(JSON.stringify(v));
    return this.db.medicalRecordRevision.create({data:{recordId,action,before:snapshot(before),after:snapshot(after),actorId:actor.sub,actorRole:actor.role}});
  }
  async create(data:Parameters<MedicalRecordRepository['create']>[0],actor:Actor){const created=await this.db.medicalRecord.create({data});await this.revise(created.id,'create',null,created,actor);return created;}
  async update(id:string,data:Parameters<MedicalRecordRepository['update']>[1],actor:Actor){
    const before=await this.db.medicalRecord.findUniqueOrThrow({where:{id}}),after=await this.db.medicalRecord.update({where:{id},data});
    await this.revise(id,'update',before,after,actor);return after;
  }
  async delete(id:string,actor:Actor){const before=await this.db.medicalRecord.delete({where:{id}});await this.revise(id,'delete',before,null,actor);}
  history(recordId:string){return this.db.medicalRecordRevision.findMany({where:{recordId},orderBy:[{changedAt:'asc'},{id:'asc'}]}) as Promise<MedicalRevisionValue[]>;}
  async createImage(data:Parameters<MedicalRecordRepository['createImage']>[0]){
    const pet=await this.directory.pet(data.petId);
    const {ownerId,sha256,imageUrl,...image}=await this.db.medicalImage.create({data:{...data,ownerId:pet.ownerId}});
    return image;
  }
  // AQ-09 retention: delete leaves a tombstone; the log row and the object's cleanup
  // claim (due when the retention window ends) commit with it, so a crash never
  // leaks the object and the worker purges row and object together later.
  async deleteImage(id:string,actor:Actor){
    const run=async(tx:Client)=>{
      const image=await lockedImage(tx,id);
      if(!image||image.deletedAt)throw new BusinessError(404,'Medical image not found.');
      const deletedAt=new Date();
      await tx.medicalImage.update({where:{id},data:{deletedAt,deletedBy:actor.sub}});
      if(image.storageKey){const claim={nextAttemptAt:new Date(deletedAt.getTime()+imageRetentionMs()),attempts:0};await tx.blobCleanup.upsert({where:{storageKey:image.storageKey},create:{storageKey:image.storageKey,...claim},update:claim});}
      await tx.medicalImageDeletion.create({data:imageLog(image,'delete',actor)});
    };
    await('$transaction' in this.db?this.db.$transaction(run):run(this.db));
  }
  // Within the window an admin restore cancels the cleanup claim under the same row
  // lock the purge takes, so either the restore or the purge wins, never both.
  async restoreImage(id:string,actor:Actor){
    const run=async(tx:Client)=>{
      const image=await lockedImage(tx,id);
      if(!image?.deletedAt)throw new BusinessError(404,'Deleted medical image not found.');
      if(image.deletedAt.getTime()<=Date.now()-imageRetentionMs())throw new BusinessError(409,'The retention window has ended; this image is being removed.');
      await tx.medicalImage.update({where:{id},data:{deletedAt:null,deletedBy:null}});
      if(image.storageKey)await tx.blobCleanup.deleteMany({where:{storageKey:image.storageKey}});
      await tx.medicalImageDeletion.create({data:imageLog(image,'restore',actor)});
    };
    await('$transaction' in this.db?this.db.$transaction(run):run(this.db));
  }
  async completeAppointment(id:string,actor:Actor){
    await unlocked(this.db,id);
    const before=await this.db.appointment.findUnique({where:{id}});
    if(!before||!['checked_in','in_progress','completed'].includes(before.status))throw new BusinessError(409,'Appointment must be checked in before medical completion.');
    if(before.status==='completed')return;
    const saved=await appointmentSlotWrite(this.db.appointment.update({where:{id},data:{status:'completed',statusRevision:{increment:1}}}));
    await appendStatusEvent(this.db,this.directory,id,actor,'medical_completed',before.status,'completed',saved.statusRevision);
    await trackAppointmentChange(this.db,id);
  }
}
export function medicalDependencies(db:PrismaClient,directory:RequestDirectory,blobs:BlobStore,bound?:Prisma.TransactionClient):MedicalDependencies{
  return{records:new Records(bound??db,directory),blobs,unitOfWork:{run:work=>transaction(db,bound,tx=>work({records:new Records(tx,directory),notifications:writer(tx)}))}};
}
export class Lifecycle implements BookingLifecycleStore {
  constructor(private readonly db:PrismaClient,private readonly directory:RequestDirectory,private readonly bound?:Prisma.TransactionClient){}
  async history(_kind:BookingKind,id:string){if(!await this.db.appointment.findUnique({where:{id}}))throw new BusinessError(404,'Appointment not found.');return this.db.bookingStatusEvent.findMany({where:{kind:'appointment',bookingId:id},orderBy:{revision:'desc'}});}
  run<T>(kind:BookingKind,id:string,work:(tx:LifecycleTransaction)=>Promise<T>){
    if(kind!=='appointment')throw new BusinessError(422,'Clinic only owns appointments.');
    return transaction(this.db,this.bound,async tx=>{
      await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;
      const booking=await tx.appointment.findUnique({where:{id}});if(!booking)throw new BusinessError(404,'Appointment not found.');
      // Same lock as prepare: never mutate a HELD/INVOICED source, including notes.
      await unlocked(tx,id);
      return work({booking,dependencies:async()=>({medical:await tx.medicalRecord.count({where:{appointmentId:id}}),invoices:await tx.appointmentReservation.count({where:{appointmentId:id,state:{in:['HELD','INVOICED']}}})}),
        latestTransition:()=>tx.bookingStatusEvent.findFirst({where:{bookingId:id,action:{not:'note_updated'}},orderBy:{revision:'desc'}}),
        save:async(status,patch={})=>{const saved=await appointmentSlotWrite(tx.appointment.update({where:{id},data:{...patch,status:status as Prisma.AppointmentUpdateInput['status'],statusRevision:{increment:1}}}));await trackAppointmentChange(tx,id);return saved;},
        event:(actor,action,from,to,rev,reason,original)=>appendStatusEvent(tx,this.directory,id,actor,action,from,to,rev,reason,original),
        notify:async(message,recipient='owner')=>{await writeNotification(tx,{recipientOwnerId:recipient==='owner'?booking.ownerId:null,recipientRole:recipient,type:'booking_status_updated',title:'Appointment updated',message,relatedPetId:booking.petId,relatedAppointmentId:id,actionUrl:recipient==='admin'?'/admin/appointments':booking.type.startsWith('spa_')?'/owner/spa-booking':'/owner/appointments'});},
      });
    });
  }
}
// Medical edit/delete also serialize with reservation and lifecycle mutations.
export async function medicalMutation<T>(db:PrismaClient,id:string,work:(tx:Prisma.TransactionClient)=>Promise<T>){
  return db.$transaction(async tx=>{const row=await tx.medicalRecord.findUnique({where:{id}});if(!row)throw new BusinessError(404,'Medical record not found.');if(row.appointmentId){await tx.$queryRaw`SELECT id FROM appointments WHERE id=${row.appointmentId} FOR UPDATE`;await unlocked(tx,row.appointmentId);}return work(tx);});
}
