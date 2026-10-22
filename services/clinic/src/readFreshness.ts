import amqp from 'amqplib';
import {requireBrokerConfig} from '@nipopeto/messaging';
import type {PrismaClient} from './generated/client/index.js';
import {ReadDiagnostics,readDiagnostics,type DiagnosticReason} from './readDiagnostics.js';
import {isProjectionVersion} from './projectionVersions.js';
import type {AuditLane} from './activitySummaryEvidence.js';

// Row evidence only (registry<->rows). schemaVersion is recorded so V1 row health
// is never read as V2 summary health; summary reconciliation evidence is separate.
export type FreshnessEvidence={generation:string;schemaVersion:number;sampledAt:number;lagMs:number;healthy:boolean};
export async function probeReadQueue(){
  const config=requireBrokerConfig();
  const connection=await amqp.connect(config.brokerUrl,{timeout:750});
  connection.on('error',()=>{});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([ (async()=>{
      const ch=await connection.createChannel();ch.on('error',()=>{});
      const queue=await ch.checkQueue(config.topology.clinicRead);
      const dead=await ch.checkQueue(config.topology.clinicRead+'.dlq');
      return queue.consumerCount>0&&dead.messageCount===0;
    })(),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),750);})]);
  }catch{return false;}finally{
    clearTimeout(timer);
    // amqplib 0.10.9 exposes the owned transport on connection.stream. Its
    // graceful close otherwise waits indefinitely for a broker CloseOk.
    let closeTimer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([connection.close().catch(()=>{}),new Promise<void>(resolve=>{
      closeTimer=setTimeout(()=>{(connection.connection as unknown as {stream:{destroy(error:Error):void}}).stream.destroy(new Error('READ_PROBE_CLOSE_TIMEOUT'));resolve();},750);
    })]);}finally{clearTimeout(closeTimer);}
  }
}
// Background only; evidence covers all registry rows, not a worker heartbeat
// or a maximum outbox ID. Fail/timeout invalidates it. One sample at a time.
export class ReadFreshness{
  evidence?:FreshnessEvidence;
  private pending?:Promise<void>;
  private timer?:ReturnType<typeof setInterval>;
  private lagSince?:number;
  private generation?:string;
  private pendingSince=new Map<string,{projected:number|null;since:number}>();
  private overflowCarry?:number;
  // requireListProjection=true keeps the list guard semantics (evidence only while
  // list servingMode=projection). Activity summary evidence uses false: the same
  // generation-bound registry<->rows audit without enabling projected lists.
  // perAggregateLag (activity, and list serving since list study v2 K3v2-F1;
  // the class default stays off for direct callers): the carried estimator keeps the oldest pending
  // time across samples even when each sample sees a DIFFERENT pending change, so
  // steady writes make lag grow without bound. Per aggregate, a change still
  // pending at the same projected version keeps its first-seen time; others start
  // at their changedAt. Over 1000 pending, the global carry is kept until clean.
  constructor(private readonly db:PrismaClient,private readonly brokerHealthy=probeReadQueue,private readonly now=()=>Date.now(),private readonly diagnostics:ReadDiagnostics=readDiagnostics,
    private readonly options:{requireListProjection?:boolean;lane?:AuditLane;perAggregateLag?:boolean}={}){}
  sample(){
    if(this.pending)return this.pending;
    this.pending=this.diagnostics.run('freshness',async()=>{
      const started=this.now();
      let reason:DiagnosticReason='broker_unavailable';
      try{
        this.diagnostics.mark('freshness-broker');
        if(!await this.brokerHealthy())throw new Error('BROKER_EVIDENCE_UNAVAILABLE');
        reason='sample_error';this.diagnostics.mark('freshness-acquire');
        const audit=()=>this.db.$transaction(async tx=>{
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout='750ms'");
          // Bound CPU fan-out of the full registry/read-row audit alongside
          // foreground cold queries. Still audit every row on every sample;
          // keep the cadence, broker probe and freshness/lag limits unchanged.
          await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');
          this.diagnostics.mark('freshness-control');
          const control=await tx.readProjectionControl.findUnique({where:{projectionName:'appointments'},include:{activeGeneration:true}});
          const g=control?.activeGeneration;
          if(((this.options.requireListProjection??true)&&control?.servingMode!=='projection')||!g||g.state!=='ACTIVE'||!isProjectionVersion(g.schemaVersion)||!g.verifiedAt||g.projectionName!=='appointments'||await tx.readRebuildRun.count({where:{frozen:true}})){reason='projection_not_ready';throw new Error('PROJECTION_NOT_READY');}
          this.diagnostics.mark('freshness-diff');
          const [diff]=await tx.$queryRaw<{pending:number;oldest:Date|null;bad:number}[]>`SELECT
            count(*) FILTER(WHERE (r.deleted AND p."appointmentId" IS NOT NULL AND p."deletedAt" IS NULL) OR (NOT r.deleted AND (p."appointmentId" IS NULL OR p."sourceVersion"<r.version OR p."deletedAt" IS NOT NULL)))::int AS pending,
            min(r."changedAt") FILTER(WHERE (r.deleted AND p."appointmentId" IS NOT NULL AND p."deletedAt" IS NULL) OR (NOT r.deleted AND (p."appointmentId" IS NULL OR p."sourceVersion"<r.version OR p."deletedAt" IS NOT NULL))) AS oldest,
            count(*) FILTER(WHERE r."aggregateId" IS NULL OR p."sourceVersion">r.version)::int AS bad
            FROM (SELECT * FROM "ClinicReadRevision" WHERE kind='appointment') r FULL JOIN (SELECT * FROM "AppointmentReadRow" WHERE generation=${g.id}) p ON r."aggregateId"=p."appointmentId"`;
          if(diff!.bad){reason='projection_version_invalid';throw new Error('PROJECTION_VERSION_INVALID');}
          const items=this.options.perAggregateLag&&diff!.pending>0&&diff!.pending<=1000?await tx.$queryRaw<{id:string;changed:Date;projected:number|null}[]>`SELECT r."aggregateId" AS id,r."changedAt" AS changed,p."sourceVersion" AS projected
            FROM (SELECT * FROM "ClinicReadRevision" WHERE kind='appointment') r LEFT JOIN (SELECT * FROM "AppointmentReadRow" WHERE generation=${g.id}) p ON r."aggregateId"=p."appointmentId"
            WHERE (r.deleted AND p."appointmentId" IS NOT NULL AND p."deletedAt" IS NULL) OR (NOT r.deleted AND (p."appointmentId" IS NULL OR p."sourceVersion"<r.version OR p."deletedAt" IS NOT NULL))`:undefined;
          this.diagnostics.mark('freshness-commit');return {generation:g.id,schemaVersion:g.schemaVersion,...diff!,items};
        },{isolationLevel:'RepeatableRead',maxWait:50,timeout:1500});
        const result=await (this.options.lane?this.options.lane.run(audit):audit());
        if(this.generation!==result.generation){this.lagSince=undefined;this.pendingSince.clear();this.overflowCarry=undefined;}
        this.generation=result.generation;
        if(!this.options.perAggregateLag)this.lagSince=result.pending?Math.min(this.lagSince??started,result.oldest?.getTime()??started):undefined;
        else if(!result.pending){this.lagSince=undefined;this.pendingSince.clear();this.overflowCarry=undefined;}
        else if(!result.items){this.overflowCarry=Math.min(this.overflowCarry??this.lagSince??started,result.oldest?.getTime()??started);this.pendingSince.clear();this.lagSince=this.overflowCarry;}
        else{
          const next=new Map<string,{projected:number|null;since:number}>();let since=started;
          for(const item of result.items){const old=this.pendingSince.get(item.id),s=old&&old.projected===item.projected?old.since:Math.min(item.changed.getTime(),started);next.set(item.id,{projected:item.projected,since:s});since=Math.min(since,s);}
          this.pendingSince=next;this.lagSince=this.overflowCarry===undefined?since:Math.min(this.overflowCarry,since);
        }
        this.evidence={generation:result.generation,schemaVersion:result.schemaVersion,sampledAt:started,lagMs:this.lagSince===undefined?0:Math.max(0,this.now()-this.lagSince),healthy:true};
        this.diagnostics.emit('sample_ok');
      }catch(error){this.evidence=undefined;this.diagnostics.emit('sample_error',reason,error);}
    }).finally(()=>{this.pending=undefined;});return this.pending;
  }
  unusableReason(generation:string):DiagnosticReason|undefined{
    const e=this.evidence;if(!e)return 'freshness_missing';
    if(!e.healthy)return 'freshness_unhealthy';
    if(e.generation!==generation)return 'freshness_generation';
    const age=this.now()-e.sampledAt;
    if(!(age>=0))return 'freshness_clock';if(!(age<=6000))return 'freshness_expired';
    if(!(e.lagMs+(e.lagMs?age:0)<=5000))return 'freshness_lag';
    return undefined;
  }
  usable(generation:string){return this.unusableReason(generation)===undefined;}
  start(){if(this.timer)return;void this.sample();this.timer=setInterval(()=>void this.sample(),2000);this.timer.unref();}
  async close(){clearInterval(this.timer);this.timer=undefined;await this.pending;}
}
