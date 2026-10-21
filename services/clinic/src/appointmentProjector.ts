import type {PrismaClient} from './generated/client/index.js';
import {parseEnvelope} from '@nipopeto/contracts';
import {appointmentReadEvent} from './readRevision.js';
import {projectionVersions,projectionInbox,assertProjectionTargets,maintainsDailySummary,type ProjectionVersion} from './projectionVersions.js';
import {contribution,summaryDeltas,applySummaryDeltas,type SummaryKey,type SummaryStage} from './clinicActivitySummary.js';

export type ProjectorStage='registry-locked'|'source-read'|'inbox-written'|SummaryStage|'row-written';
export class AppointmentProjector{
  readonly stats={applied:0,duplicates:0,failures:0,summaryBuckets:0,durationMs:0};
  constructor(private readonly db:PrismaClient,private readonly onStage?:(stage:ProjectorStage)=>Promise<void>,private readonly capability:readonly ProjectionVersion[]=projectionVersions){}
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
        // Every target of any version is read, so a V1-only binary fails (no ACK)
        // instead of silently skipping a V2 generation it cannot maintain.
        const generations=await tx.readProjectionGeneration.findMany({where:{projectionName:'appointments',state:{in:['BUILDING','READY','ACTIVE']}},orderBy:{id:'asc'},take:3,select:{id:true,schemaVersion:true}});
        if(!generations.length||generations.length>2)throw new Error('READ_PROJECTION_GENERATION_BUDGET');
        assertProjectionTargets(this.capability,generations);
        const source=await tx.appointment.findUnique({where:{id:event.aggregateId},include:{reservations:{select:{state:true}}}});
        if(revision.deleted?!!source:!source)throw new Error('READ_SOURCE_REGISTRY_MISMATCH');
        await this.onStage?.('source-read');
        const writes:{generation:string;action:'delete'|'upsert'|'none'}[]=[],counters:{before?:SummaryKey;after?:SummaryKey}[]=[];
        for(const generation of generations){
          const inserted=await tx.$executeRaw`INSERT INTO "InboxEvent" ("consumerName","eventId","createdAt") VALUES (${projectionInbox(generation)},${event.eventId},now()) ON CONFLICT DO NOTHING`;
          if(!inserted)continue;
          await this.onStage?.('inbox-written');
          // Old row is read before any mutation; only registry-lock holders write it.
          const old=await tx.appointmentReadRow.findUnique({where:{generation_appointmentId:{generation:generation.id,appointmentId:event.aggregateId}},select:{sourceVersion:true,appointmentDate:true,type:true,status:true,deletedAt:true}});
          if(old&&old.sourceVersion>revision.version)throw new Error('READ_PROJECTION_AHEAD_OF_SOURCE');
          const action=revision.deleted?'delete':!old||old.sourceVersion<revision.version?'upsert':'none';
          writes.push({generation:generation.id,action});
          if(maintainsDailySummary(generation.schemaVersion as ProjectionVersion)){
            // Contribution of the row as it will be after this transaction:
            // hydrated latest source, deleted, or unchanged at the same version.
            const after=action==='delete'?undefined:action==='upsert'?source!:old;
            counters.push({before:contribution(generation.id,old),after:contribution(generation.id,after)});
          }
        }
        // Summary buckets before rows: the row statement trigger takes the global
        // projection epoch row, so every writer locks buckets (sorted) -> epoch.
        const deltas=summaryDeltas(counters);
        await applySummaryDeltas(tx,deltas,this.onStage);
        for(const {generation,action} of writes){
          if(action==='delete')await tx.appointmentReadRow.deleteMany({where:{generation,appointmentId:event.aggregateId}});
          else if(action==='upsert'){
            const a=source!,key={generation_appointmentId:{generation,appointmentId:a.id}};
            // Explicit allowlist. No medical/directory data or actor ACL copied.
            const row={sourceVersion:revision.version,petId:a.petId,ownerId:a.ownerId,doctorId:a.doctorId,type:a.type,
              serviceName:a.serviceName,clinicName:a.clinicName,appointmentDate:a.appointmentDate,appointmentTime:a.appointmentTime,
              status:a.status,statusRevision:a.statusRevision,ownerNote:a.ownerNote,internalNote:a.internalNote,createdBy:a.createdBy,
              createdAt:a.createdAt,updatedAt:a.updatedAt,billingHeld:a.reservations.some(r=>r.state==='HELD'),
              billingInvoiced:a.reservations.some(r=>r.state==='INVOICED'),deletedAt:null,projectedAt:new Date()};
            await tx.appointmentReadRow.upsert({where:key,create:{generation,appointmentId:a.id,...row},update:row});
          }
          await this.onStage?.('row-written');
        }
        return {changed:writes.length>0,buckets:deltas.length};
      },{isolationLevel:'ReadCommitted',timeout:15000,maxWait:3000});
      if(applied.changed)this.stats.applied++;else this.stats.duplicates++;
      this.stats.summaryBuckets+=applied.buckets;
      return applied.changed;
    }catch(error){this.stats.failures++;throw error;}
    finally{this.stats.durationMs+=performance.now()-start;}
  }
  metrics(){return ['applied','duplicates','failures'].map(name=>'clinic_read_projector_'+name+'_total '+this.stats[name as 'applied'|'duplicates'|'failures']).join('\n')+'\nclinic_read_projector_summary_buckets_total '+this.stats.summaryBuckets+'\nclinic_read_projector_duration_ms_total '+this.stats.durationMs+'\n';}
}
