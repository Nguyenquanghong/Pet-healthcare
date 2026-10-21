import type {PrismaClient} from './generated/client/index.js';
import {summaryDrift} from './clinicActivitySummary.js';
import {maintainsDailySummary,type ProjectionVersion} from './projectionVersions.js';
import type {ReadFreshness} from './readFreshness.js';

// Serializes background audits sharing the one explicit audit connection, so the
// 2s row audit and the 30s summary audit never contend for its pool slot.
export class AuditLane{
  private tail:Promise<unknown>=Promise.resolve();
  run<T>(work:()=>Promise<T>):Promise<T>{const result=this.tail.then(work,work);this.tail=result.catch(()=>{});return result;}
}

export type SummaryEvidence={generation:string;sampledAt:number;durationMs:number;driftBuckets:number;healthy:boolean};
export type SummaryIneligible='capability_v1_only'|'summary_generation_missing'|'summary_not_v2'|'summary_frozen'|'summary_sample_error'
  |'summary_evidence_missing'|'summary_evidence_generation'|'summary_evidence_clock'|'summary_evidence_expired'|'summary_drift'|'rows_schema_version'|`rows_${string}`;
type Options={intervalMs:number;ttlMs:number};
// ADR-activity-01 §7: periodic rows<->summary per bucket, 30s cadence, evidence
// TTL 60s, one in flight, 1500ms statement/2500ms tx/50ms maxWait, no parallel
// workers. Independent of the list servingMode. Never run per HTTP request; the
// drift window between samples is a known limit, not a staleness guarantee.
export class ActivitySummaryEvidence{
  evidence?:SummaryEvidence;
  failure?:SummaryIneligible;
  private failedGeneration?:string;
  readonly stats={samples:0,healthy:0,drift:0,errors:0};
  private pending?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  constructor(private readonly db:PrismaClient,private readonly rows:ReadFreshness,private readonly capability:readonly ProjectionVersion[],
    private readonly lane=new AuditLane(),private readonly now=()=>Date.now(),private readonly options:Options={intervalMs:30000,ttlMs:60000}){}
  sample(){
    if(this.pending)return this.pending;
    const started=this.now();this.stats.samples++;
    let reason:SummaryIneligible='summary_sample_error',seen:string|undefined;
    this.pending=this.lane.run(()=>this.db.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='1500ms'");
      await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');
      const control=await tx.readProjectionControl.findUnique({where:{projectionName:'appointments'},include:{activeGeneration:true}});
      const g=control?.activeGeneration;seen=g?.id;
      if(!g||g.state!=='ACTIVE'||!g.verifiedAt||g.projectionName!=='appointments'){reason='summary_generation_missing';throw new Error('SUMMARY_NOT_READY');}
      if(!maintainsDailySummary(g.schemaVersion as ProjectionVersion)){reason='summary_not_v2';throw new Error('SUMMARY_NOT_READY');}
      if(await tx.readRebuildRun.count({where:{frozen:true}})){reason='summary_frozen';throw new Error('SUMMARY_NOT_READY');}
      return {generation:g.id,drift:(await summaryDrift(tx,g.id)).rows};
    },{isolationLevel:'RepeatableRead',maxWait:50,timeout:2500})).then(result=>{
      const healthy=result.drift===0;
      this.evidence={generation:result.generation,sampledAt:started,durationMs:this.now()-started,driftBuckets:result.drift,healthy};
      this.failure=healthy?undefined:'summary_drift';this.failedGeneration=undefined;
      if(healthy)this.stats.healthy++;else{this.stats.drift++;process.stdout.write(JSON.stringify({service:'clinic-activity-evidence',event:'summary_drift',driftBuckets:result.drift})+'\n');}
    },()=>{this.evidence=undefined;this.failure=reason;this.failedGeneration=seen;this.stats.errors++;}).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  // Summary is eligible only with a V1+V2 binary, fresh healthy reconciliation
  // and usable row evidence for the SAME V2 generation. Row health alone never
  // implies summary health; queue state/heartbeat/MAX(projectedAt) are not inputs.
  ineligibleReason(generation:string):SummaryIneligible|undefined{
    if(!this.capability.some(maintainsDailySummary))return 'capability_v1_only';
    // A failure observed for another (older) generation says nothing about this one.
    const e=this.evidence;if(!e)return this.failedGeneration&&this.failedGeneration!==generation?'summary_evidence_generation':this.failure??'summary_evidence_missing';
    if(e.generation!==generation)return 'summary_evidence_generation';
    const age=this.now()-e.sampledAt;
    if(!(age>=0))return 'summary_evidence_clock';if(!(age<=this.options.ttlMs))return 'summary_evidence_expired';
    if(!e.healthy)return 'summary_drift';
    if(this.rows.evidence?.generation===generation&&this.rows.evidence.schemaVersion!==2)return 'rows_schema_version';
    const rows=this.rows.unusableReason(generation);if(rows)return `rows_${rows}`;
    return undefined;
  }
  eligible(generation:string){return this.ineligibleReason(generation)===undefined;}
  // Response metadata: oldest evidence sample time and the row audit's lag.
  observed(){const r=this.rows.evidence,s=this.evidence;return r&&s?{checkedAt:Math.min(r.sampledAt,s.sampledAt),lagMs:r.lagMs}:undefined;}
  start(){if(this.timer)return;void this.sample();this.timer=setInterval(()=>void this.sample(),this.options.intervalMs);this.timer.unref();}
  async close(){clearInterval(this.timer);this.timer=undefined;await this.pending;}
}
