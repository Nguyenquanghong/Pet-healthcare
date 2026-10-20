import {Prisma,type AppointmentStatus} from '../../generated/client/index.js';
import {ReadDiagnostics,readDiagnostics} from '../../readDiagnostics.js';

type Counts={status:AppointmentStatus;n:number;held:number};
type Dates={date:Date;n:number};
// Split work, not snapshots or authorization. Boundaries are traversal metadata
// only: every aggregate retains its complete source ACL and filter predicates.
// No partial result escapes if a later statement or the enclosing tx fails.
export async function boundedAppointmentAggregate<T extends Counts|Dates>(
  tx:Prisma.TransactionClient,generation:string,statement:(range:Prisma.Sql)=>Prisma.Sql,
  key:(row:T)=>string,deadline?:number,diagnostics:ReadDiagnostics=readDiagnostics,
):Promise<T[]>{
  const result=new Map<string,T>();let lower:string|undefined;
  for(;;){
    if(deadline!==undefined&&performance.now()>=deadline)throw new Error('APPOINTMENT_AGGREGATE_DEADLINE');
    // Take the boundary and one lookahead. This also handles arbitrary string
    // IDs, sparse/deleted rows and an exactly full final batch without guessing
    // UUID distribution. Every aggregate INNER JOINs source identity, so source
    // IDs partition all contributing rows (including when projection is stale).
    // Seek the source PK: a freshly rebuilt projection has no visibility-map
    // coverage and seeking its PK would revisit 100k wide heap rows in total.
    // 40k ranges pair with the aggregate covering indexes; reducing the range
    // alone repeats wide heap scans and increases admission pressure.
    diagnostics.mark('projection-aggregate-boundary');
    const cursor=await tx.appointment.findMany({
      where:lower===undefined?{}:{id:{gt:lower}},
      select:{id:true},orderBy:{id:'asc'},skip:39999,take:2,
    });
    const upper=cursor.length===2?cursor[0]!.id:undefined;
    const range=Prisma.sql`${lower===undefined?Prisma.empty:Prisma.sql`AND p."appointmentId">${lower} AND a.id>${lower}`} ${upper===undefined?Prisma.empty:Prisma.sql`AND p."appointmentId"<=${upper} AND a.id<=${upper}`}`;
    if(deadline!==undefined&&performance.now()>=deadline)throw new Error('APPOINTMENT_AGGREGATE_DEADLINE');
    diagnostics.mark(lower===undefined?'projection-aggregate-first':'projection-aggregate-next');
    const rows=await tx.$queryRaw<T[]>(statement(range));
    for(const row of rows){
      const k=key(row),prior=result.get(k);
      if(prior){prior.n+=row.n;if('held' in prior&&'held' in row)prior.held+=row.held;}
      else result.set(k,{...row});
    }
    if(upper===undefined)return [...result.values()];
    if(upper===lower)throw new Error('APPOINTMENT_AGGREGATE_CURSOR');
    lower=upper;
  }
}
