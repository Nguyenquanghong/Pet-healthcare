// AQ-09 guarded operator tool: move legacy base64 medical images into the bucket (Claim Check).
// Usage: node tools/phase2/migrate-medical-images.mjs --dry-run|--run|--orphans [--delete-orphans] [--min-age-seconds N]
// DATABASE_URL and BLOB_* come from the environment. Refuses any database except the
// marked pet-phase2-p1-test Clinic database. Idempotent: rows are updated with a compare-and-set.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PrismaClient} from '../../services/clinic/src/generated/client/index.js';
import {S3BlobStore,blobStoreFromEnv} from '../../services/clinic/dist/blobStore.js';
import {imageContent} from '../../services/clinic/dist/domain/validation.js';

const args=process.argv.slice(2),mode=args[0],deleteOrphans=args.includes('--delete-orphans');
const ageAt=args.indexOf('--min-age-seconds'),minAge=ageAt>0?Number(args[ageAt+1]):3600;
assert.ok(['--dry-run','--run','--orphans'].includes(mode)&&Number.isInteger(minAge)&&minAge>=0,'Use --dry-run, --run or --orphans');
const db=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});
try{
  const [identity]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;
  assert.deepEqual(identity,{db:'p2_clinic_test',role:'p2_clinic'},'MEDICAL_IMAGE_MIGRATION_TEST_DATABASE_ONLY');
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  const blobs=blobStoreFromEnv();assert.ok(blobs instanceof S3BlobStore,'BLOB_STORE_CONFIGURATION_REQUIRED');
  const [size]=await db.$queryRaw`SELECT count(*)::int AS legacy,COALESCE(sum(octet_length(image_url)),0)::bigint AS "legacyBytes" FROM medical_images WHERE image_url IS NOT NULL`;
  const report={mode,legacyRows:size.legacy,legacyBytes:Number(size.legacyBytes),migrated:0,failed:[],orphans:[]};
  if(mode==='--run'){
    await blobs.ensureBucket();
    for(;;){
      const rows=await db.medicalImage.findMany({where:{imageUrl:{not:null},storageKey:null,id:{notIn:report.failed.map(f=>f.id)}},orderBy:{id:'asc'},take:10});
      if(!rows.length)break;
      for(const row of rows){
        try{
          const bytes=imageContent(row.imageUrl,row.mimeType),sha256=createHash('sha256').update(bytes).digest('hex'),storageKey='images/'+row.id;
          await blobs.put(storageKey,bytes,row.mimeType);
          // Read back through a valet key before dropping the inline copy.
          const back=await fetch(blobs.signedGetUrl(storageKey).url);
          assert.equal(back.status,200);assert.equal(createHash('sha256').update(Buffer.from(await back.arrayBuffer())).digest('hex'),sha256);
          const changed=await db.$executeRaw`UPDATE medical_images SET storage_key=${storageKey},size_bytes=${bytes.length},sha256=${sha256},image_url=NULL WHERE id=${row.id} AND image_url=${row.imageUrl} AND storage_key IS NULL`;
          if(changed)report.migrated++;
        }catch(error){report.failed.push({id:row.id,error:error.status?error.message:error.message?.slice(0,80)??'error'});}
      }
    }
  }
  if(mode==='--orphans'){
    const keys=new Set((await db.medicalImage.findMany({where:{storageKey:{not:null}},select:{storageKey:true}})).map(r=>r.storageKey));
    const queued=new Set((await db.blobCleanup.findMany({select:{storageKey:true}})).map(r=>r.storageKey));
    const cutoff=Date.now()-minAge*1000;
    // Young objects may belong to an upload whose row is still being inserted.
    for(const object of await blobs.list('images/'))if(!keys.has(object.key)&&!queued.has(object.key)&&object.lastModified.getTime()<=cutoff){
      report.orphans.push(object.key);if(deleteOrphans)await blobs.remove(object.key);
    }
    report.orphansDeleted=deleteOrphans;
  }
  const [after]=await db.$queryRaw`SELECT count(*)::int AS legacy,pg_total_relation_size('medical_images')::bigint AS "tableBytes" FROM medical_images WHERE image_url IS NOT NULL`;
  Object.assign(report,{legacyRowsAfter:after.legacy,tableBytes:Number(after.tableBytes)});
  console.log(JSON.stringify(report));
  if(report.failed.length)process.exitCode=2;
}finally{await db.$disconnect();}
