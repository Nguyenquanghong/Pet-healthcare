import {createHash} from 'node:crypto';
import type {Prisma} from '../../generated/client/index.js';
import {ReadDiagnostics,readDiagnostics} from '../../readDiagnostics.js';

// Owned by one serving reader/database, never shared across database instances.
// Values contain only grouped counts/dates, not DTOs, auth decisions or tokens.
export class AppointmentAggregateCache{
  private readonly entries=new Map<string,{expires:number;value:unknown}>();
  private readonly pending=new Map<string,Promise<unknown>>();
  private active?:Promise<void>;
  private waiting=0;
  readonly stats={hits:0,misses:0,coalesced:0,queued:0};
  constructor(private readonly now=()=>performance.now(),private readonly maxEntries=128,private readonly ttlMs=5000){
    if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>128||!Number.isFinite(ttlMs)||ttlMs<=0||ttlMs>5000)throw new Error('APPOINTMENT_QUERY_CACHE_BOUNDS');
  }
  private async bounded<T>(work:Promise<T>,deadline:number){
    const remaining=deadline-performance.now();if(remaining<=0)throw new Error('APPOINTMENT_AGGREGATE_BUSY');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('APPOINTMENT_AGGREGATE_BUSY')),remaining);})]);}
    finally{clearTimeout(timer);}
  }
  private async slot(readDeadline?:number){
    if(this.waiting>=4)throw new Error('APPOINTMENT_AGGREGATE_BUSY');
    this.waiting++;const deadline=Math.min(performance.now()+200,readDeadline??Infinity);
    try{
      while(this.active){
        this.stats.queued++;await this.bounded(this.active,deadline);
      }
      if(performance.now()>=deadline)throw new Error('APPOINTMENT_AGGREGATE_BUSY');
      let release!:()=>void;this.active=new Promise<void>(r=>{release=r;});
      return ()=>{this.active=undefined;release();};
    }finally{this.waiting--;}
  }
  async read<T>(tx:Prisma.TransactionClient,sql:Prisma.Sql,actorScope:string,readDeadline?:number,diagnostics:ReadDiagnostics=readDiagnostics,compute?:()=>Promise<T>):Promise<T>{
    // Must run in the reader's read-only RepeatableRead snapshot. Every relevant
    // write changes its epoch atomically, including direct SQL/imports/deletes.
    // TTL bounds memory lifetime; it is NOT the correctness/invalidation guard.
    const epochs=await tx.$queryRaw<{scope:string;revision:string;readOnly:string;isolation:string}[]>`SELECT scope,revision::text AS revision,current_setting('transaction_read_only') AS "readOnly",current_setting('transaction_isolation') AS isolation FROM "AppointmentQueryEpoch" ORDER BY scope`;
    if(epochs.length!==3||epochs.map(r=>r.scope).join(',')!=='directory,projection,source-acl'||epochs.some(r=>!/^[1-9]\d*$/.test(r.revision)||r.readOnly!=='on'||r.isolation!=='repeatable read'))throw new Error('APPOINTMENT_QUERY_EPOCH_UNAVAILABLE');
    const key=createHash('sha256').update(JSON.stringify([actorScope,epochs,sql.text,sql.values])).digest('hex');
    const cached=this.entries.get(key),now=this.now();
    if(cached&&now<cached.expires){cached.expires=now+this.ttlMs;this.stats.hits++;diagnostics.emit('cache_hit');return structuredClone(cached.value) as T;}
    const pending=this.pending.get(key);
    // Identical epochs/SQL/actor imply identical aggregate across these readonly
    // snapshots. Share computation only after each caller rechecks its epochs.
    if(pending){this.stats.coalesced++;diagnostics.emit('cache_coalesced');return structuredClone(await this.bounded(pending,Math.min(performance.now()+200,readDeadline??Infinity))) as T;}
    this.stats.misses++;
    diagnostics.emit('cache_miss');
    const work=(async()=>{
      // Bound cache-miss concurrency, not DB pool or serving statement budget.
      // Up to four waiters, at most200ms admission within the outer tx deadline.
      if(this.active)diagnostics.emit('cache_wait');
      const release=await this.slot(readDeadline);let value:T;
      try{value=await (compute?compute():tx.$queryRaw<T>(sql));}finally{release();}
      const completed=this.now();
      for(const [k,v] of this.entries)if(v.expires<=completed)this.entries.delete(k);
      this.entries.delete(key);
      while(this.entries.size>=this.maxEntries)this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key,{expires:completed+this.ttlMs,value:structuredClone(value)});
      return value;
    })();
    this.pending.set(key,work);
    try{return structuredClone(await work);}finally{this.pending.delete(key);}
  }
}
