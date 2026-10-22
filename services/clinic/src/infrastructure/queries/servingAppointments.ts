import type {PrismaClient} from '../../generated/client/index.js';
import {Prisma} from '../../generated/client/index.js';
import type {AppointmentQueries} from '../../application/ports/appointmentQueries.js';
import type {ReadVersions} from '../../readToken.js';
import {ReadFreshness} from '../../readFreshness.js';
import {BusinessError} from '../../domain/error.js';
import {ProjectedAppointmentQueries} from './projectedAppointments.js';
import {AuthoritativeAppointmentQueries} from './authoritativeAppointments.js';
import {snapshotDatabase} from './shadowAppointments.js';
import {ReadDiagnostics,readDiagnostics,type DiagnosticReason} from '../../readDiagnostics.js';
import {AppointmentAggregateCache} from './appointmentAggregateCache.js';
import {ProjectionAdmission} from './projectionAdmission.js';
import {isProjectionVersion} from '../../projectionVersions.js';
export type ReadResult<T>={data:T;source:'authoritative'|'projection';generation?:string;degraded?:boolean};
class PendingVersion extends Error{}
export const PROJECTED_STATEMENT_MAX_MS=1000;
export class ServingAppointmentQueries{
  private fallbacks=0;
  private readonly admission:ProjectionAdmission;
  readonly stats={projection:0,fallback:0,rejected:0};
  constructor(private readonly db:PrismaClient,readonly freshness:ReadFreshness,private readonly diagnostics:ReadDiagnostics=readDiagnostics,private readonly aggregateCache:AppointmentAggregateCache|null=new AppointmentAggregateCache(),projectionSlots=1){
    this.admission=new ProjectionAdmission(undefined,projectionSlots);
  }
  private async source<T>(run:(reader:AppointmentQueries)=>Promise<T>,reason:DiagnosticReason):Promise<ReadResult<T>>{
    this.diagnostics.mark('fallback-acquire');
    if(this.fallbacks>=2){this.stats.rejected++;this.diagnostics.emit('fallback_busy',reason);throw new BusinessError(503,'Clinic read fallback is busy. Retry later.');}
    this.fallbacks++;this.stats.fallback++;
    try{
      const data=await this.db.$transaction(async tx=>{
        this.diagnostics.mark('fallback-setup');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='1500ms'");
        this.diagnostics.mark('fallback-query');
        const result=await run(new AuthoritativeAppointmentQueries(snapshotDatabase(tx)));
        this.diagnostics.mark('fallback-commit');return result;
      },{isolationLevel:'RepeatableRead',maxWait:50,timeout:2500});
      if(reason!=='forced_source')this.diagnostics.emit('fallback_ok',reason);
      return {data,source:'authoritative',degraded:true};
    }catch(error){this.diagnostics.emit('fallback_error',reason,error);throw error;}finally{this.fallbacks--;}
  }
  async read<T>(run:(reader:AppointmentQueries)=>Promise<T>,versions:ReadVersions={},forceSource=false):Promise<ReadResult<T>>{
    return this.diagnostics.run('unknown',()=>this.readWithDiagnostics(run,versions,forceSource));
  }
  private async readWithDiagnostics<T>(run:(reader:AppointmentQueries)=>Promise<T>,versions:ReadVersions,forceSource:boolean):Promise<ReadResult<T>>{
    if(forceSource)return this.source(run,'forced_source');
    const hasVersions=Object.keys(versions).length>0;
    const deadline=performance.now()+(hasVersions?500:1250);
    let reason:DiagnosticReason='budget_exhausted';
    for(let poll=0;poll<6;poll++){
      if(deadline-performance.now()<1)break;
      try{
        reason='query_error';this.diagnostics.mark('projection-admission');
        if(this.admission.busy)this.diagnostics.emit('admission_wait');
        const release=await this.admission.acquire(deadline);
        try{
          const remaining=Math.floor(deadline-performance.now());
          if(remaining<1){reason='budget_exhausted';throw new Error('PROJECTION_ADMISSION_BUSY');}
          this.diagnostics.emit('admission_ready');
          this.diagnostics.mark('projection-acquire');
          const result=await this.db.$transaction(async tx=>{
            this.diagnostics.mark('projection-setup');
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            // Each projected statement may use the request's remaining budget (capped).
            // A fixed 200ms cap was ~1.7x the normal p95 and turned brief DB jitter into
            // whole-query fallback (list study v1 K2-F1); the deadline still bounds it.
            await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='${Math.min(PROJECTED_STATEMENT_MAX_MS,remaining)}ms'`);
            this.diagnostics.mark('projection-control');
            // The pointer and token check share the query's RepeatableRead snapshot.
            const c=await tx.readProjectionControl.findUnique({where:{projectionName:'appointments'},include:{activeGeneration:true}});
            if(!c?.activeGenerationId||c.servingMode!=='projection'||c.activeGeneration?.state!=='ACTIVE'||!c.activeGeneration.verifiedAt||!isProjectionVersion(c.activeGeneration.schemaVersion)||c.activeGeneration.projectionName!=='appointments'){reason='control_unavailable';throw new Error('PROJECTION_UNAVAILABLE');}
            if(!this.freshness.usable(c.activeGenerationId)){reason=this.freshness.unusableReason(c.activeGenerationId)??'freshness_missing';throw new Error('PROJECTION_UNAVAILABLE');}
            const ids=Object.keys(versions);
            if(ids.length){
              this.diagnostics.mark('projection-token');
              const rows=await tx.$queryRaw<{id:string;version:number;deleted:boolean;projected:number|null;deletedAt:Date|null}[]>(Prisma.sql`SELECT r."aggregateId" AS id,r.version,r.deleted,p."sourceVersion" AS projected,p."deletedAt" FROM "ClinicReadRevision" r LEFT JOIN "AppointmentReadRow" p ON p.generation=${c.activeGenerationId} AND p."appointmentId"=r."aggregateId" WHERE r.kind='appointment' AND r."aggregateId" IN (${Prisma.join(ids)})`);
              if(rows.length!==ids.length||rows.some(r=>r.version<versions[r.id]!|| (r.deleted? r.projected!==null&&r.deletedAt===null : r.projected===null||r.projected<versions[r.id]!||r.deletedAt!==null)))throw new PendingVersion();
            }
            this.diagnostics.mark('projection-query');
            const data=await run(new ProjectedAppointmentQueries(snapshotDatabase(tx),c.activeGenerationId,this.diagnostics,this.aggregateCache??undefined,deadline));
            this.diagnostics.mark('projection-commit');
            return {data,source:'projection' as const,generation:c.activeGenerationId};
          },{isolationLevel:'RepeatableRead',maxWait:Math.min(50,remaining),timeout:remaining});
          this.stats.projection++;this.diagnostics.emit('projection_ok');return result;
        }finally{release();}
      }catch(error){
        if(error instanceof BusinessError&&error.status<500)throw error;
        if(error instanceof PendingVersion)reason='version_pending';
        this.diagnostics.emit('projection_failure',reason,error);
        if(!(error instanceof PendingVersion)||performance.now()+50>=deadline)break;
        await new Promise(r=>setTimeout(r,50));
      }
    }
    return this.source(run,reason);
  }
}
