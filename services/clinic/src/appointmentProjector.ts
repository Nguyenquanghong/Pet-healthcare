import type {PrismaClient} from './generated/client/index.js';
import {parseEnvelope} from '@nipopeto/contracts';
import {appointmentReadEvent} from './readRevision.js';

export type ProjectorStage='registry-locked'|'source-read'|'row-written';
export class AppointmentProjector{
  readonly stats={applied:0,duplicates:0,failures:0,durationMs:0};
  constructor(private readonly db:PrismaClient,private readonly onStage?:(stage:ProjectorStage)=>Promise<void>){}
  async apply(raw:string){
    const start=performance.now();
    try{
      const event=parseEnvelope(raw);
      if(event.eventType!==appointmentReadEvent)throw new Error('UNSUPPORTED_EVENT');
      const applied=await this.db.$transaction(async tx=>{
        // Registry first. No source FOR UPDATE: writers lock source then registry.
        // ReadCommitted sees the latest committed source after this lock is held.
        const [revision]=await tx.$queryRaw<{version:number;deleted:boolean}[]>`SELECT version,deleted FROM "ClinicReadRevision" WHERE kind='appointment' AND "aggregateId"=${event.aggregateId} FOR UPDATE`;
        if(!revision||revision.version<event.aggregateVersion)throw new Error('READ_SOURCE_VERSION_UNAVAILABLE');
        if(revision.version===event.aggregateVersion&&revision.deleted!==event.payload.deleted)throw new Error('READ_EVENT_TOMBSTONE_MISMATCH');
        await this.onStage?.('registry-locked');
        const controls=await tx.$queryRaw<{projectionName:string}[]>`SELECT "projectionName" FROM "ReadProjectionControl" WHERE "projectionName"='appointments' FOR SHARE`;
        if(!controls.length)throw new Error('READ_PROJECTION_NOT_INITIALIZED');
        const generations=await tx.readProjectionGeneration.findMany({where:{projectionName:'appointments',schemaVersion:1,state:{in:['BUILDING','READY','ACTIVE']}},orderBy:{id:'asc'},take:3});
        if(!generations.length||generations.length>2)throw new Error('READ_PROJECTION_GENERATION_BUDGET');
        const source=await tx.appointment.findUnique({where:{id:event.aggregateId},include:{reservations:{select:{state:true}}}});
        if(revision.deleted?!!source:!source)throw new Error('READ_SOURCE_REGISTRY_MISMATCH');
        await this.onStage?.('source-read');
        let changed=false;
        for(const generation of generations){
          const consumerName='clinic-read-v1:'+generation.id;
          const inserted=await tx.$executeRaw`INSERT INTO "InboxEvent" ("consumerName","eventId","createdAt") VALUES (${consumerName},${event.eventId},now()) ON CONFLICT DO NOTHING`;
          if(!inserted)continue;
          changed=true;
          const key={generation_appointmentId:{generation:generation.id,appointmentId:event.aggregateId}};
          const old=await tx.appointmentReadRow.findUnique({where:key,select:{sourceVersion:true}});
          if(old&&old.sourceVersion>revision.version)throw new Error('READ_PROJECTION_AHEAD_OF_SOURCE');
          if(revision.deleted){await tx.appointmentReadRow.deleteMany({where:{generation:generation.id,appointmentId:event.aggregateId}});}
          else if(!old||old.sourceVersion<revision.version){
            const a=source!;
            // Explicit allowlist. No medical/directory data or actor ACL copied.
            const row={sourceVersion:revision.version,petId:a.petId,ownerId:a.ownerId,doctorId:a.doctorId,type:a.type,
              serviceName:a.serviceName,clinicName:a.clinicName,appointmentDate:a.appointmentDate,appointmentTime:a.appointmentTime,
              status:a.status,statusRevision:a.statusRevision,ownerNote:a.ownerNote,internalNote:a.internalNote,createdBy:a.createdBy,
              createdAt:a.createdAt,updatedAt:a.updatedAt,billingHeld:a.reservations.some(r=>r.state==='HELD'),
              billingInvoiced:a.reservations.some(r=>r.state==='INVOICED'),deletedAt:null,projectedAt:new Date()};
            await tx.appointmentReadRow.upsert({where:key,create:{generation:generation.id,appointmentId:a.id,...row},update:row});
          }
          await this.onStage?.('row-written');
        }
        return changed;
      },{isolationLevel:'ReadCommitted',timeout:15000,maxWait:3000});
      if(applied)this.stats.applied++;else this.stats.duplicates++;
      return applied;
    }catch(error){this.stats.failures++;throw error;}
    finally{this.stats.durationMs+=performance.now()-start;}
  }
  metrics(){return ['applied','duplicates','failures'].map(name=>'clinic_read_projector_'+name+'_total '+this.stats[name as 'applied'|'duplicates'|'failures']).join('\n')+'\nclinic_read_projector_duration_ms_total '+this.stats.durationMs+'\n';}
}
