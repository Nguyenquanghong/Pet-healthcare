import type {PrismaClient} from './generated/client/index.js';
import type {BlobStore} from './blobStore.js';

// AQ-09: removes bucket objects whose image row is already deleted (blob_cleanup
// is written in the delete transaction). Idempotent, safe with several workers.
export async function drainBlobCleanup(db:PrismaClient,blobs:BlobStore,{limit=50,now=new Date()}:{limit?:number;now?:Date}={}){
  const due=await db.blobCleanup.findMany({where:{nextAttemptAt:{lte:now}},orderBy:{nextAttemptAt:'asc'},take:limit});
  let removed=0;
  for(const row of due){
    try{
      await blobs.remove(row.storageKey);
      await db.blobCleanup.deleteMany({where:{storageKey:row.storageKey}});
      removed++;
    }catch{
      // Exponential backoff, at most one hour.
      const seconds=Math.min(30*2**Math.min(row.attempts,7),3600);
      // updateMany: another worker may have removed the row meanwhile.
      await db.blobCleanup.updateMany({where:{storageKey:row.storageKey},data:{attempts:{increment:1},nextAttemptAt:new Date(now.getTime()+seconds*1000)}});
    }
  }
  return{due:due.length,removed};
}
