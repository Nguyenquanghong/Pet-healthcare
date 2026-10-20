import {AsyncLocalStorage} from 'node:async_hooks';

// Opt-in, bounded diagnostic telemetry. Never serialize an exception, query,
// actor, request header, identifier or message. This is not a latency metric.
export const diagnosticOperations=['unknown','freshness','owner-list','owner-calendar','admin-list','admin-calendar','admin-page','admin-search','admin-filter','admin-unbilled'] as const;
export const diagnosticStages=['start','projection-admission','projection-acquire','projection-setup','projection-control','projection-token','projection-query','projection-plan','projection-search','projection-counts','projection-aggregate-boundary','projection-aggregate-first','projection-aggregate-next','projection-items','projection-directory-version','projection-directory','projection-calendar','projection-commit','fallback-acquire','fallback-setup','fallback-query','fallback-commit','freshness-broker','freshness-acquire','freshness-control','freshness-diff','freshness-commit'] as const;
export const diagnosticEvents=['enabled','admission_wait','admission_ready','cache_hit','cache_miss','cache_coalesced','cache_wait','projection_ok','projection_failure','fallback_ok','fallback_error','fallback_busy','sample_ok','sample_error','limit'] as const;
export const diagnosticReasons=['none','query_error','control_unavailable','freshness_missing','freshness_expired','freshness_generation','freshness_lag','freshness_unhealthy','freshness_clock','version_pending','budget_exhausted','broker_unavailable','projection_not_ready','projection_version_invalid','sample_error','forced_source'] as const;
export type DiagnosticOperation=typeof diagnosticOperations[number];
export type DiagnosticStage=typeof diagnosticStages[number];
export type DiagnosticEvent=typeof diagnosticEvents[number];
export type DiagnosticReason=typeof diagnosticReasons[number];
const prismaCodes=new Set(['P1001','P1002','P1008','P1017','P2010','P2021','P2022','P2024','P2028','P2034']);
const sqlStates=new Set(['57014','55P03','53100','53200','53300','40001','40P01','42501','42P01','42703','08006']);
type Context={id:number;operation:DiagnosticOperation;stage:DiagnosticStage;started:number;stageStarted:number};
export class ReadDiagnostics{
  private readonly context=new AsyncLocalStorage<Context>();
  private nextId=0;
  private emitted=0;
  private limited=false;
  private readonly successes=new Set<string>();
  constructor(readonly enabled=process.env.CLINIC_READ_DIAGNOSTICS==='1',private readonly sink=(line:string)=>{process.stderr.write(line);}){}
  run<T>(operation:DiagnosticOperation,fn:(id?:number)=>Promise<T>):Promise<T>{
    if(!this.enabled)return fn();
    const current=this.context.getStore();
    if(current)return fn(current.id);
    const now=performance.now();
    const context:Context={id:++this.nextId,operation:diagnosticOperations.includes(operation)?operation:'unknown',stage:'start',started:now,stageStarted:now};
    return this.context.run(context,()=>{if(this.nextId===1)this.emit('enabled');return fn(context.id);});
  }
  mark(stage:DiagnosticStage){
    if(!this.enabled)return;
    const c=this.context.getStore();
    if(c&&diagnosticStages.includes(stage)){c.stage=stage;c.stageStarted=performance.now();}
  }
  emit(event:DiagnosticEvent,reason:DiagnosticReason='none',error?:unknown){
    const c=this.context.getStore();
    if(!this.enabled||!c||this.limited||!diagnosticEvents.includes(event)||!diagnosticReasons.includes(reason))return;
    if(['projection_ok','sample_ok','admission_wait','admission_ready','cache_hit','cache_miss','cache_coalesced','cache_wait'].includes(event)){
      const key=c.operation+':'+event;if(this.successes.has(key))return;this.successes.add(key);
    }
    // One terminal marker makes truncation explicit. Memory/cardinality and
    // writes stay bounded even during a long outage or malicious inputs.
    if(this.emitted>=512){event='limit';reason='none';error=undefined;this.limited=true;}
    try{
      const e=error as {code?:unknown;meta?:{code?:unknown}}|undefined;
      const code=typeof e?.code==='string'&&prismaCodes.has(e.code)?e.code:null;
      const state=typeof e?.meta?.code==='string'&&sqlStates.has(e.meta.code)?e.meta.code:null;
      const now=performance.now();
      const row={version:1,sequence:++this.emitted,id:c.id,operation:c.operation,stage:c.stage,event,reason,
        prismaCode:code,sqlState:state,atUnixMs:Date.now(),elapsedMs:Math.round(Math.max(0,now-c.started)*1000)/1000,
        stageMs:Math.round(Math.max(0,now-c.stageStarted)*1000)/1000};
      this.sink('CLINIC_READ_DIAGNOSTIC '+JSON.stringify(row)+'\n');
    }catch{/* Diagnostic failures must not change the read/fallback result. */}
  }
}
export const readDiagnostics=new ReadDiagnostics();

export function diagnosticOperation(owner:boolean,calendar:boolean,q:Record<string,unknown>):DiagnosticOperation{
  if(calendar)return owner?'owner-calendar':'admin-calendar';
  if(owner)return 'owner-list';
  if(q.mode==='unbilled')return 'admin-unbilled';
  if(q.q)return 'admin-search';
  if((typeof q.page==='string'||typeof q.page==='number')&&Number(q.page)>1)return 'admin-page';
  if(['status','statusGroup','ownerId','petId','date','category','id'].some(k=>q[k]))return 'admin-filter';
  return 'admin-list';
}
