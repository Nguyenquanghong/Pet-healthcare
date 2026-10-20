import {Prisma,type PrismaClient} from './generated/client/index.js';
import {appointmentFields,sourceSnapshot,reconcileProjection} from './projectionSnapshot.js';

const uuid=(v:string)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v))throw new Error('INVALID_REBUILD_ID');};
const fenceTables='"InboxEvent","RequestDedup",appointments,"AppointmentReservation","AppointmentBillingTerminal",medical_records,medical_images,booking_status_events,"DirectoryProjection","ClinicReadRevision","ReadProjectionControl","ReadProjectionGeneration","AppointmentReadRow","OutboxEvent"';
export class AppointmentRebuild{
  private held=false;
  // Caller: guarded operator, private connection_limit=1, drained trial workers.
  constructor(private readonly db:PrismaClient){}
  private async pid(){const [r]=await this.db.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;return r!.pid;}
  async inspect(){return {source:await this.db.appointment.count(),registry:await this.db.clinicReadRevision.count(),rows:await this.db.appointmentReadRow.count(),generations:await this.db.readProjectionGeneration.findMany({select:{id:true,state:true}}),runs:await this.db.readRebuildRun.findMany({select:{id:true,generation:true,state:true,frozen:true,copied:true}})};}
  private async fingerprint(tx:Prisma.TransactionClient){
    const [r]=await tx.$queryRaw<{hash:string}[]>`SELECT md5(concat(
      (SELECT string_agg(md5(to_jsonb(a)::text),'' ORDER BY id) FROM appointments a),
      (SELECT string_agg(md5(to_jsonb(b)::text),'' ORDER BY "operationId") FROM "AppointmentReservation" b),
      (SELECT string_agg(md5(to_jsonb(r)::text),'' ORDER BY kind,"aggregateId") FROM "ClinicReadRevision" r),
      (SELECT string_agg(md5(to_jsonb(d)::text),'' ORDER BY kind,id) FROM "DirectoryProjection" d))) AS hash`;
    return r!.hash;
  }
  async claim(runId:string,generation:string,{abortOnly=false}={}){
    uuid(runId);uuid(generation);
    if(!this.held){const [lock]=await this.db.$queryRaw<{held:boolean}[]>`SELECT pg_try_advisory_lock(hashtext(current_schema()),730003) AS held`;
      if(!lock!.held)throw new Error('REBUILD_OPERATOR_BUSY');this.held=true;}
    const pid=await this.pid();
    // Persist fence first. A crash keeps other writers fenced until resume/abort.
    await this.db.$transaction(async tx=>{
      const old=await tx.readRebuildRun.findUnique({where:{id:runId}});
      if(old){if(old.generation!==generation||!old.frozen||!['BUILDING','READY'].includes(old.state))throw new Error('REBUILD_NOT_RESUMABLE');await tx.readRebuildRun.update({where:{id:runId},data:{ownerPid:pid}});}
      else{if(abortOnly)throw new Error('REBUILD_NOT_FOUND');const control=await tx.readProjectionControl.findUnique({where:{projectionName:'appointments'}});await tx.readRebuildRun.create({data:{id:runId,generation,ownerPid:pid,expectedGeneration:control?.activeGenerationId??null}});}
    });
    if(abortOnly)return {run:runId,generation,state:'ABORT_REQUESTED',copied:0};
    // A bounded drain also covers the tiny interval between a reader returning
    // rows and PostgreSQL releasing its implicit-transaction locks.
    return this.db.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1000ms'");
      await tx.$executeRawUnsafe(`LOCK TABLE ${fenceTables} IN ACCESS EXCLUSIVE MODE`);
      const run=await tx.readRebuildRun.findUniqueOrThrow({where:{id:runId}});
      const conflict=await tx.$queryRaw<{n:number}[]>`SELECT count(*)::int AS n FROM appointments a JOIN "ClinicReadRevision" r ON r.kind='appointment' AND r."aggregateId"=a.id WHERE r.deleted`;
      if(conflict[0]!.n)throw new Error('REBUILD_TOMBSTONE_CONFLICT');
      await tx.$executeRaw`INSERT INTO "ClinicReadRevision" (kind,"aggregateId",version,deleted,"changedAt") SELECT 'appointment',id,1,false,now() FROM appointments ON CONFLICT DO NOTHING`;
      const hash=await this.fingerprint(tx);
      if(run.sourceHash&&run.sourceHash!==hash)throw new Error('REBUILD_SOURCE_DRIFT');
      const control=await tx.readProjectionControl.upsert({where:{projectionName:'appointments'},create:{projectionName:'appointments'},update:{servingMode:'authoritative'}});
      if(control.activeGenerationId!==run.expectedGeneration)throw new Error('REBUILD_POINTER_CHANGED');
      const old=await tx.readProjectionGeneration.findUnique({where:{id:generation}});
      if(old&&(!run.sourceHash||old.projectionName!=='appointments'||old.schemaVersion!==1||!['BUILDING','READY'].includes(old.state)))throw new Error('REBUILD_GENERATION_INVALID');
      // Retain previous interrupted BUILDING rows; stop targeting them, never
      // retire the active generation until atomic switch.
      await tx.readProjectionGeneration.updateMany({where:{id:{not:generation},state:{in:['BUILDING','READY']}},data:{state:'RETIRED'}});
      if(!old)await tx.readProjectionGeneration.create({data:{id:generation}});
      await tx.readRebuildRun.update({where:{id:runId},data:{sourceHash:hash}});
      return {run:runId,generation,state:run.state,copied:run.copied};
    },{timeout:30000});
  }
  private async owned(tx:Prisma.TransactionClient,id:string){
    const run=await tx.readRebuildRun.findUniqueOrThrow({where:{id}});
    const [r]=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
    if(!run.frozen||run.ownerPid!==r!.pid)throw new Error('REBUILD_FENCE_NOT_OWNED');return run;
  }
  async batch(id:string,size=500){
    if(!Number.isInteger(size)||size<1||size>2000)throw new Error('INVALID_REBUILD_BATCH');
    return this.db.$transaction(async tx=>{
      const run=await this.owned(tx,id);if(run.state!=='BUILDING')throw new Error('REBUILD_NOT_BUILDING');
      const ids=await tx.appointment.findMany({where:run.checkpoint?{id:{gt:run.checkpoint}}:{},orderBy:{id:'asc'},take:size,select:{id:true}});
      if(!ids.length)return {done:true,copied:run.copied};
      const fields=['appointmentId','sourceVersion',...Object.keys(appointmentFields),'billingHeld','billingInvoiced'];
      const columns=Prisma.raw(fields.map(f=>`"${f}"`).join(','));
      const updates=Prisma.raw(fields.filter(f=>f!=='appointmentId').map(f=>`"${f}"=EXCLUDED."${f}"`).join(','));
      await tx.$executeRaw(Prisma.sql`INSERT INTO "AppointmentReadRow" (generation,${columns}) SELECT ${run.generation},s.* FROM (${sourceSnapshot}) s WHERE s."appointmentId" IN (${Prisma.join(ids.map(r=>r.id))}) ON CONFLICT (generation,"appointmentId") DO UPDATE SET ${updates},"projectedAt"=now()`);
      const next=await tx.readRebuildRun.update({where:{id},data:{checkpoint:ids.at(-1)!.id,copied:{increment:ids.length}}});
      return {done:false,copied:next.copied};
    },{timeout:30000});
  }
  async verify(id:string){return this.db.$transaction(async tx=>{
    const run=await this.owned(tx,id);
    if(await this.fingerprint(tx)!==run.sourceHash)throw new Error('REBUILD_SOURCE_DRIFT');
    const diff=await reconcileProjection(tx,run.generation);
    if(Object.values(diff).some(n=>n!==0))throw new Error('REBUILD_RECONCILIATION_MISMATCH');
    await tx.readProjectionGeneration.update({where:{id:run.generation},data:{state:'READY',verifiedAt:new Date()}});
    await tx.readRebuildRun.update({where:{id},data:{state:'READY'}});return diff;
  },{timeout:30000});}
  async activate(id:string){return this.db.$transaction(async tx=>{
    const run=await this.owned(tx,id);if(run.state!=='READY')throw new Error('REBUILD_NOT_READY');
    const target=await tx.readProjectionGeneration.findUniqueOrThrow({where:{id:run.generation}});
    if(target.state!=='READY'||!target.verifiedAt||target.schemaVersion!==1||target.projectionName!=='appointments')throw new Error('REBUILD_GENERATION_INVALID');
    await tx.$queryRaw`SELECT "projectionName" FROM "ReadProjectionControl" WHERE "projectionName"='appointments' FOR UPDATE`;
    if(await this.fingerprint(tx)!==run.sourceHash)throw new Error('REBUILD_SOURCE_DRIFT');
    const diff=await reconcileProjection(tx,run.generation);if(Object.values(diff).some(n=>n!==0))throw new Error('REBUILD_RECONCILIATION_MISMATCH');
    const swapped=await tx.readProjectionControl.updateMany({where:{projectionName:'appointments',activeGenerationId:run.expectedGeneration},data:{activeGenerationId:run.generation,servingMode:'authoritative'}});
    if(swapped.count!==1)throw new Error('REBUILD_POINTER_CHANGED');
    if(run.expectedGeneration)await tx.readProjectionGeneration.update({where:{id:run.expectedGeneration},data:{state:'RETIRED'}});
    await tx.readProjectionGeneration.update({where:{id:run.generation},data:{state:'ACTIVE'}});
    await tx.readRebuildRun.update({where:{id},data:{state:'COMPLETE',frozen:false}});
    return {generation:run.generation,servingMode:'authoritative'};
  },{timeout:30000});}
  async abort(id:string){return this.db.$transaction(async tx=>{
    const run=await this.owned(tx,id);
    await tx.readProjectionGeneration.updateMany({where:{id:run.generation,state:{in:['BUILDING','READY']}},data:{state:'RETIRED'}});
    await tx.readProjectionControl.updateMany({where:{projectionName:'appointments'},data:{servingMode:'authoritative'}});
    await tx.readRebuildRun.update({where:{id},data:{frozen:false,state:'ABORTED'}});
  });}
  async close(){if(this.held){await this.db.$queryRaw`SELECT pg_advisory_unlock(hashtext(current_schema()),730003) AS released`;this.held=false;}}
}
