import {Prisma} from './generated/client/index.js';
import {appointmentStatuses,appointmentTypes,type AppointmentStatus,type AppointmentType} from './application/ports/appointments.js';

// One bucket of AppointmentDailySummary. appointmentDate is the SQL DATE as
// YYYY-MM-DD (business day), never createdAt or a host-timezone conversion.
export type SummaryKey={generation:string;appointmentDate:string;type:AppointmentType;status:AppointmentStatus};
export type SummaryDelta={key:SummaryKey;delta:number};
export type ContributionRow={appointmentDate:Date;type:string;status:string;deletedAt?:Date|null};
export type SummaryStage='summary-decremented'|'summary-incremented';

const day=(d:Date)=>{if(!(d instanceof Date)||Number.isNaN(d.getTime()))throw new Error('READ_SUMMARY_INVALID_DATE');return d.toISOString().slice(0,10);};
// A live read row contributes exactly 1 to one bucket; a missing or deleted row 0.
export function contribution(generation:string,row:ContributionRow|null|undefined):SummaryKey|undefined{
  if(!row||row.deletedAt)return undefined;
  if(!(appointmentTypes as readonly string[]).includes(row.type)||!(appointmentStatuses as readonly string[]).includes(row.status))throw new Error('READ_SUMMARY_UNKNOWN_BUCKET');
  return {generation,appointmentDate:day(row.appointmentDate),type:row.type as AppointmentType,status:row.status as AppointmentStatus};
}
const ordinal=(k:SummaryKey)=>[k.generation,k.appointmentDate,appointmentTypes.indexOf(k.type),appointmentStatuses.indexOf(k.status)] as const;
// Same total order for every writer, independent of decrement/increment sign,
// so A->B and B->A transfers lock shared buckets in one direction.
export function compareSummaryKeys(a:SummaryKey,b:SummaryKey){
  const x=ordinal(a),y=ordinal(b);
  for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]!<y[i]!?-1:1;
  return 0;
}
const id=(k:SummaryKey)=>k.generation+'\0'+k.appointmentDate+'\0'+k.type+'\0'+k.status;
// Delta = contribution(old read row) -> contribution(row after this apply). The
// event is a change notification, never a delta itself. Zero deltas are dropped:
// note/billing/doctor changes inside one bucket touch no counter.
export function summaryDeltas(changes:readonly {before?:SummaryKey;after?:SummaryKey}[]):SummaryDelta[]{
  const merged=new Map<string,SummaryDelta>();
  const add=(key:SummaryKey|undefined,delta:number)=>{if(!key)return;const k=id(key),old=merged.get(k);if(old)old.delta+=delta;else merged.set(k,{key,delta});};
  for(const c of changes){add(c.before,-1);add(c.after,1);}
  return [...merged.values()].filter(d=>d.delta!==0).sort((a,b)=>compareSummaryKeys(a.key,b.key));
}

// Bucket-level drift, zero counters normalized. rows: summary vs live read rows of
// the generation (must hold at every snapshot by row+summary atomicity). source:
// summary vs registry-live appointments (holds only when caught up/frozen).
export async function summaryDrift(tx:Prisma.TransactionClient,generation:string,{source=false}={}){
  const sourceDrift=source?Prisma.sql`(SELECT count(*) FROM (SELECT a.appointment_date d,a.type t,a.status s,count(*)::bigint n FROM appointments a
    JOIN "ClinicReadRevision" v ON v.kind='appointment' AND v."aggregateId"=a.id AND NOT v.deleted GROUP BY 1,2,3) x FULL JOIN m USING (d,t,s) WHERE x.n IS DISTINCT FROM m.n)::int`:Prisma.sql`NULL::int`;
  const [r]=await tx.$queryRaw<{rows:number;source:number|null}[]>(Prisma.sql`WITH m AS (SELECT "appointmentDate" d,type t,status s,"appointmentCount" n FROM "AppointmentDailySummary" WHERE generation=${generation} AND "appointmentCount"<>0),
    r AS (SELECT "appointmentDate" d,type t,status s,count(*)::bigint n FROM "AppointmentReadRow" WHERE generation=${generation} AND "deletedAt" IS NULL GROUP BY 1,2,3)
    SELECT (SELECT count(*) FROM r FULL JOIN m USING (d,t,s) WHERE r.n IS DISTINCT FROM m.n)::int AS rows,${sourceDrift} AS source`);
  return {rows:r!.rows,source:r!.source};
}

// Canonical V2 summary for a frozen, fully backfilled generation: replace all of
// its counters with GROUP BY of its rows. Re-running after a crash yields the same
// result; never combined with per-row increments.
export async function replaceSummary(tx:Prisma.TransactionClient,generation:string){
  await tx.$executeRaw`DELETE FROM "AppointmentDailySummary" WHERE generation=${generation}`;
  return tx.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"schemaVersion","appointmentCount")
    SELECT generation,"appointmentDate",type,status,2,count(*) FROM "AppointmentReadRow" WHERE generation=${generation} AND "deletedAt" IS NULL GROUP BY 1,2,3,4`;
}

// Atomic SQL counters in the caller's projector transaction. Decrement requires
// an existing bucket with enough count; missing/underflow aborts the whole
// transaction (row + summary + inbox) instead of clamping to 0.
export async function applySummaryDeltas(tx:Prisma.TransactionClient,deltas:readonly SummaryDelta[],onStage?:(stage:SummaryStage)=>Promise<void>){
  for(const {key:k,delta} of deltas){
    if(!Number.isSafeInteger(delta)||delta===0)throw new Error('READ_SUMMARY_INVALID_DELTA');
    const n=BigInt(Math.abs(delta));
    if(delta<0){
      const updated=await tx.$executeRaw`UPDATE "AppointmentDailySummary" SET "appointmentCount"="appointmentCount"-${n}
        WHERE generation=${k.generation} AND "appointmentDate"=CAST(${k.appointmentDate} AS date) AND type=CAST(${k.type} AS "AppointmentType") AND status=CAST(${k.status} AS "AppointmentStatus") AND "appointmentCount">=${n}`;
      if(updated!==1){
        const [found]=await tx.$queryRaw<{n:number}[]>`SELECT count(*)::int AS n FROM "AppointmentDailySummary"
          WHERE generation=${k.generation} AND "appointmentDate"=CAST(${k.appointmentDate} AS date) AND type=CAST(${k.type} AS "AppointmentType") AND status=CAST(${k.status} AS "AppointmentStatus")`;
        throw new Error(found?.n?'READ_SUMMARY_COUNTER_UNDERFLOW':'READ_SUMMARY_BUCKET_MISSING');
      }
      await onStage?.('summary-decremented');
    }else{
      await tx.$executeRaw`INSERT INTO "AppointmentDailySummary" (generation,"appointmentDate",type,status,"appointmentCount")
        VALUES (${k.generation},CAST(${k.appointmentDate} AS date),CAST(${k.type} AS "AppointmentType"),CAST(${k.status} AS "AppointmentStatus"),${n})
        ON CONFLICT (generation,"appointmentDate",type,status) DO UPDATE SET "appointmentCount"="AppointmentDailySummary"."appointmentCount"+EXCLUDED."appointmentCount"`;
      await onStage?.('summary-incremented');
    }
  }
}
