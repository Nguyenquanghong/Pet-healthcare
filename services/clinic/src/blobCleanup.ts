import type {PrismaClient} from './generated/client/index.js';
import type {BlobStore} from './blobStore.js';
import {integer} from '@nipopeto/runtime';

// AQ-09 retention: how long a deleted medical image stays restorable (a
// tombstone row plus its bucket object) before the worker purges both.
export const imageRetentionMs=()=>integer('MEDICAL_IMAGE_RETENTION_DAYS',30,1,3650)*86400000;

type Tombstone={id:string;petId:string;ownerId:string;storageKey:string|null;sha256:string|null;sizeBytes:number|null;deletedAt:Date|null};
const purgeLog=(image:Tombstone)=>({imageId:image.id,action:'purge',petId:image.petId,ownerId:image.ownerId,storageKey:image.storageKey,sha256:image.sha256,sizeBytes:image.sizeBytes,actorId:'system',actorRole:'system'});

// Removes bucket objects whose cleanup claim is due (written in the delete
// transaction, due when the retention window ends). The tombstone row is purged
// first under a row lock: a concurrent restore either wins the lock and cancels
// the claim, or finds the row gone, so a restored image never loses its object.
// Idempotent, safe with several workers.
export async function drainBlobCleanup(db:PrismaClient,blobs:BlobStore,{limit=50,now=new Date()}:{limit?:number;now?:Date}={}){
  const due=await db.blobCleanup.findMany({where:{nextAttemptAt:{lte:now}},orderBy:{nextAttemptAt:'asc'},take:limit});
  let removed=0,purged=0;
  for(const row of due){
    try{
      const restored=await db.$transaction(async tx=>{
        const [image]=await tx.$queryRaw<Tombstone[]>`SELECT id,pet_id AS "petId",owner_id AS "ownerId",storage_key AS "storageKey",sha256,size_bytes AS "sizeBytes",deleted_at AS "deletedAt" FROM medical_images WHERE storage_key=${row.storageKey} FOR UPDATE`;
        if(image&&!image.deletedAt)return true;
        if(image){await tx.medicalImageDeletion.create({data:purgeLog(image)});await tx.medicalImage.delete({where:{id:image.id}});purged++;}
        return false;
      });
      if(!restored)await blobs.remove(row.storageKey);
      await db.blobCleanup.deleteMany({where:{storageKey:row.storageKey}});
      if(!restored)removed++;
    }catch{
      // Exponential backoff, at most one hour.
      const seconds=Math.min(30*2**Math.min(row.attempts,7),3600);
      // updateMany: another worker may have removed the row meanwhile.
      await db.blobCleanup.updateMany({where:{storageKey:row.storageKey},data:{attempts:{increment:1},nextAttemptAt:new Date(now.getTime()+seconds*1000)}});
    }
  }
  // Legacy inline images have no object or claim: purge their tombstones by age.
  const cutoff=new Date(now.getTime()-imageRetentionMs());
  for(const {id} of await db.medicalImage.findMany({where:{storageKey:null,deletedAt:{lte:cutoff}},select:{id:true},take:limit})){
    await db.$transaction(async tx=>{
      const [image]=await tx.$queryRaw<Tombstone[]>`SELECT id,pet_id AS "petId",owner_id AS "ownerId",storage_key AS "storageKey",sha256,size_bytes AS "sizeBytes",deleted_at AS "deletedAt" FROM medical_images WHERE id=${id} FOR UPDATE`;
      if(!image?.deletedAt||image.deletedAt>cutoff)return;
      await tx.medicalImageDeletion.create({data:purgeLog(image)});await tx.medicalImage.delete({where:{id}});purged++;
    });
  }
  return{due:due.length,removed,purged};
}
