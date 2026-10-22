import {randomUUID} from 'node:crypto';
import type {Prisma,PrismaClient} from './generated/client/index.js';
import {parseEnvelope,type Envelope} from '@nipopeto/contracts';
import {currentRequestId} from '@nipopeto/runtime';
import {BusinessError} from './domain/error.js';
import {readProjectionEnabled} from './readProjection.js';

export const appointmentReadEvent='clinic.appointment-read-changed.v1' as const;
type Client=Prisma.TransactionClient;
export type RevisionOptions={created?:boolean;deleted?:boolean;onStage?:(stage:'after-revision'|'after-outbox')=>Promise<void>};

// Caller owns the source row lock and transaction. Never call after its commit.
export async function recordAppointmentChange(tx:Client,id:string,options:RevisionOptions={}){
  if(options.created&&options.deleted)throw new Error('INVALID_READ_CHANGE');
  let version:number;
  if(options.created){
    await tx.clinicReadRevision.create({data:{kind:'appointment',aggregateId:id,version:1}});version=1;
  }else{
    const rows=await tx.$queryRaw<{version:number}[]>`UPDATE "ClinicReadRevision" SET version=version+1,deleted=${options.deleted??false},"changedAt"=clock_timestamp()
      WHERE kind='appointment' AND "aggregateId"=${id} AND NOT deleted AND version<2147483647 RETURNING version`;
    if(!rows[0]){
      const old=await tx.clinicReadRevision.findUnique({where:{kind_aggregateId:{kind:'appointment',aggregateId:id}}});
      if(old?.version===2147483647)throw new BusinessError(409,'Appointment read revision exhausted.');
      throw new Error(old?.deleted?'READ_SOURCE_TOMBSTONED':'READ_REVISION_MISSING_RUN_GUARDED_INITIALIZATION');
    }version=rows[0].version;
  }
  await options.onStage?.('after-revision');
  const eventId=randomUUID();
  const event:Envelope={eventId,eventType:appointmentReadEvent,schemaVersion:1,producer:'clinic',aggregateType:'appointment',aggregateId:id,
    aggregateVersion:version,occurredAt:new Date().toISOString(),correlationId:currentRequestId()??eventId,
    payload:{appointmentId:id,sourceVersion:version,deleted:options.deleted??false}};
  parseEnvelope(JSON.stringify(event));
  await tx.outboxEvent.create({data:{id:eventId,envelope:event as unknown as Prisma.InputJsonValue}});
  await options.onStage?.('after-outbox');
  return {version,eventId};
}

// Write-path entry point: a no-op while CLINIC_READ_PROJECTION is off.
export async function trackAppointmentChange(tx:Client,id:string,options:RevisionOptions={}){
  if(!readProjectionEnabled())return undefined;
  return recordAppointmentChange(tx,id,options);
}

// Initial adoption only, not a rebuild/cutover. Call from an environment-guarded
// operator tool with old APIs/imports/billing writers stopped. SQL lock drains
// in-flight source writers; version rows/tombstones are never reset.
export async function initializeAppointmentProjection(db:PrismaClient,generation:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation))throw new Error('INVALID_GENERATION');
  return db.$transaction(async tx=>{
    await tx.$executeRawUnsafe('LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE');
    if(await tx.readProjectionControl.count())throw new Error('PROJECTION_ALREADY_INITIALIZED');
    const conflicts=await tx.$queryRaw<{n:number}[]>`SELECT count(*)::int AS n FROM appointments a JOIN "ClinicReadRevision" r ON r.kind='appointment' AND r."aggregateId"=a.id WHERE r.deleted`;
    if(conflicts[0]!.n)throw new Error('TOMBSTONE_SOURCE_CONFLICT');
    const registered=await tx.$executeRaw`INSERT INTO "ClinicReadRevision" (kind,"aggregateId",version,deleted,"changedAt") SELECT 'appointment',id,1,false,now() FROM appointments ON CONFLICT DO NOTHING`;
    await tx.readProjectionGeneration.create({data:{id:generation,state:'BUILDING'}});
    await tx.readProjectionControl.create({data:{projectionName:'appointments',servingMode:'authoritative'}});
    return {generation,registered,servingMode:'authoritative'};
  },{timeout:30000});
}
