import {Prisma,AppointmentStatus,type PrismaClient,type Appointment} from '../../generated/client/index.js';
import type {Actor} from '../../domain/auth.js';
import {BusinessError} from '../../domain/error.js';
import type {AppointmentQueries,AppointmentQueryDirectory,AppointmentCalendarQuery} from '../../application/ports/appointmentQueries.js';
import {appointmentDto} from '../../lib/serialize.js';
import {query} from './authoritativeLists.js';
import {AuthoritativeAppointmentQueries} from './authoritativeAppointments.js';
import {readColumns} from '../../projectionSnapshot.js';
import {ReadDiagnostics,readDiagnostics} from '../../readDiagnostics.js';
import {AppointmentAggregateCache} from './appointmentAggregateCache.js';

import {boundedAppointmentAggregate} from './boundedAppointmentAggregate.js';

const statusOrder=Object.values(AppointmentStatus);
type CubeRow={status:AppointmentStatus;date:Date;type:string;n:number;held:number};
const spa=['spa_bath','spa_grooming','spa_combo'];
const groups:Record<string,string[]>={pending:['pending','confirmed','checked_in','in_progress'],completed:['completed'],cancelled:['cancelled','no_show']};
// Internal reader: public Q4 serving must pass the freshness/token/fallback gate.
export class ProjectedAppointmentQueries implements AppointmentQueries{
  constructor(private readonly db:PrismaClient,private readonly generation:string,private readonly diagnostics:ReadDiagnostics=readDiagnostics,private readonly aggregateCache?:AppointmentAggregateCache,private readonly readDeadline?:number){}
  private aggregate<T>(tx:Prisma.TransactionClient,actor:Actor,sql:Prisma.Sql,compute?:()=>Promise<T>){
    return this.aggregateCache?this.aggregateCache.read<T>(tx,sql,JSON.stringify([actor.role,actor.sub]),this.readDeadline,this.diagnostics,compute):(compute?compute():tx.$queryRaw<T>(sql));
  }
  private cube(tx:Prisma.TransactionClient,actor:Actor){
    const statement=(range:Prisma.Sql)=>Prisma.sql`SELECT p.status,p."appointmentDate" AS date,p.type::text AS type,count(*)::int AS n,count(*) FILTER(WHERE p."billingHeld")::int AS held FROM "AppointmentReadRow" p JOIN appointments a ON a.id=p."appointmentId" WHERE ${this.scope(actor)} ${range} GROUP BY p.status,p."appointmentDate",p.type`;
    return this.aggregate<CubeRow[]>(tx,actor,statement(Prisma.empty),()=>boundedAppointmentAggregate<CubeRow>(tx,this.generation,statement,r=>JSON.stringify([r.status,r.date.toISOString(),r.type]),this.readDeadline,this.diagnostics));
  }
  private category(type:string,category:unknown){return !category||(category==='spa'?spa.includes(type):!spa.includes(type));}
  // Join on source identity, then require both authorization fields to match.
  // Keep that check as one boolean guard: treating id/owner/pet as independent
  // join keys estimated ~10 matches for 100k rows and selected costly sorts.
  // CASE also denies NULL/unknown; it never substitutes projection authority.
  private scope(actor:Actor){return Prisma.sql`p.generation=${this.generation} AND p."deletedAt" IS NULL AND a.id=p."appointmentId" AND CASE WHEN a.owner_id=p."ownerId" AND a.pet_id=p."petId" THEN TRUE ELSE FALSE END ${actor.role==='owner'?Prisma.sql`AND a.owner_id=${actor.sub} AND p."ownerId"=${actor.sub}`:Prisma.empty}`;}
  async list(actor:Actor,directory:AppointmentQueryDirectory,raw:Record<string,unknown>){
    const q=query('appointments',raw);
    // Financial selection is always authoritative, including shadow diagnostics.
    if(q.mode==='unbilled')return new AuthoritativeAppointmentQueries(this.db).list(actor,directory,raw);
    const result=await this.db.$transaction(async tx=>{
      // Owner/date/search predicates vary from a few rows to the whole model.
      // A cached generic plan can underestimate a full month and turn the ACL
      // join into 100k source probes. Keep the setting local to this snapshot.
      this.diagnostics.mark('projection-plan');
      // With epoch-validated aggregate reuse, cold misses are serialized by the
      // serving cache. Serial range scans avoid parallel fan-out alongside freshness
      // and authoritative unbilled reads; keep both settings transaction-local.
      await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');
      await tx.$executeRawUnsafe("SET LOCAL plan_cache_mode='force_custom_plan'");
      const parts=[this.scope(actor)];
      if(actor.role!=='owner'&&q.ownerId)parts.push(Prisma.sql`a.owner_id=${q.ownerId} AND p."ownerId"=${q.ownerId}`);
      if(q.petId)parts.push(Prisma.sql`a.pet_id=${q.petId} AND p."petId"=${q.petId}`);
      if(q.id)parts.push(Prisma.sql`p."appointmentId"=${q.id}`);
      if(q.date)parts.push(Prisma.sql`p."appointmentDate"=${new Date(q.date+'T00:00:00Z')}`);
      if(q.category)parts.push(q.category==='spa'?Prisma.sql`p.type::text IN (${Prisma.join(spa)})`:Prisma.sql`p.type::text NOT IN (${Prisma.join(spa)})`);
      if(q.q){
        this.diagnostics.mark('projection-search');
        // Resolve directory matches once per snapshot, as the authoritative
        // reader does. A correlated directory scan per appointment makes a
        // 100k-row search exceed the bounded serving statement budget.
        const text=(field:string)=>({[field]:{contains:q.q as string,mode:'insensitive' as const}});
        const matches=await tx.directoryProjection.findMany({where:{deletedAt:null,OR:[text('displayName'),text('phone'),text('breed'),text('email'),text('microchipId'),text('id')]},select:{kind:true,id:true}});
        const ownerIds=matches.filter(r=>r.kind==='owner').map(r=>r.id),petIds=matches.filter(r=>r.kind==='pet').map(r=>r.id);
        const owned=await tx.directoryProjection.findMany({where:{kind:'pet',deletedAt:null,ownerId:{in:ownerIds}},select:{id:true}});petIds.push(...owned.map(r=>r.id));
        // Directory results are search predicates only; source ACL JOIN stays.
        const pattern='%'+q.q+'%';
        parts.push(Prisma.sql`(${petIds.length?Prisma.sql`p."petId" IN (${Prisma.join(petIds)})`:Prisma.sql`FALSE`} OR ${ownerIds.length?Prisma.sql`p."ownerId" IN (${Prisma.join(ownerIds)})`:Prisma.sql`FALSE`} OR p."serviceName" ILIKE ${pattern} OR p."appointmentId" ILIKE ${pattern})`);
      }
      const base=Prisma.join(parts,' AND '),where=[...parts];
      if(q.statusGroup)where.push(Prisma.sql`p.status::text IN (${Prisma.join(groups[q.statusGroup as string]!)})`);
      if(q.status)where.push(Prisma.sql`p.status::text=${q.status}`);
      this.diagnostics.mark('projection-counts');
      const statement=(range:Prisma.Sql)=>Prisma.sql`SELECT p.status,count(*)::int AS n,count(*) FILTER(WHERE p."billingHeld")::int AS held FROM "AppointmentReadRow" p JOIN appointments a ON a.id=p."appointmentId" WHERE ${base} ${range} GROUP BY p.status ORDER BY p.status`;
      const broad=actor.role!=='owner'&&!q.ownerId&&!q.petId&&!q.id;
      let grouped:{status:AppointmentStatus;n:number;held:number}[];
      if(broad&&!q.q){
        const rows=await this.cube(tx,actor),counts=new Map<AppointmentStatus,{status:AppointmentStatus;n:number;held:number}>();
        for(const r of rows){
          if(q.date&&r.date.toISOString().slice(0,10)!==q.date||!this.category(r.type,q.category))continue;
          const prior=counts.get(r.status);if(prior){prior.n+=r.n;prior.held+=r.held;}else counts.set(r.status,{status:r.status,n:r.n,held:r.held});
        }
        grouped=[...counts.values()];
      }else grouped=await this.aggregate<{status:AppointmentStatus;n:number;held:number}[]>(tx,actor,statement(Prisma.empty),broad?()=>boundedAppointmentAggregate<{status:AppointmentStatus;n:number;held:number}>(tx,this.generation,statement,r=>r.status,this.readDeadline,this.diagnostics):undefined);
      grouped.sort((a,b)=>statusOrder.indexOf(a.status)-statusOrder.indexOf(b.status));
      const counts:Record<string,number>=Object.fromEntries(grouped.map(r=>[r.status,r.n]));
      const total=grouped.reduce((sum,r)=>sum+((!q.status||q.status===r.status)&&(!q.statusGroup||groups[q.statusGroup as string]!.includes(r.status))?r.n:0),0);
      counts.billingHeld=grouped.reduce((sum,r)=>sum+r.held,0);
      // Status is the first ordering key. Exact, ACL-filtered counts from this
      // same snapshot let us skip whole status groups without sorting them.
      // Keep every group intersecting the page, including boundary crossings.
      const pageStatuses:string[]=[];let skip=(q.page-1)*q.pageSize,left=q.pageSize,pageOffset=0;
      for(const r of grouped){
        if(q.status&&q.status!==r.status||q.statusGroup&&!groups[q.statusGroup as string]!.includes(r.status))continue;
        if(skip>=r.n){skip-=r.n;continue;}
        if(!pageStatuses.length)pageOffset=skip;
        pageStatuses.push(r.status);left-=Math.min(left,r.n-skip);skip=0;if(!left)break;
      }
      if(pageStatuses.length)where.push(Prisma.sql`p.status IN (${Prisma.join(pageStatuses.map(s=>Prisma.sql`${s}::"AppointmentStatus"`))})`);
      const order=actor.role==='owner'?Prisma.sql`p.status ASC,p."appointmentDate" DESC,p."appointmentTime" DESC,p."appointmentId" DESC`:Prisma.sql`p.status ASC,p."createdAt" DESC,p."appointmentId" DESC`;
      // Apply every filter and source ACL before pagination, but sort only keys.
      // Fetch wide notes/DTO fields only for the selected page, not 100k rows.
      this.diagnostics.mark('projection-items');
      const appointments=pageStatuses.length?await tx.$queryRaw<Appointment[]>(Prisma.sql`SELECT p."appointmentId" AS id,${readColumns} FROM "AppointmentReadRow" p JOIN (
        SELECT p."appointmentId" FROM "AppointmentReadRow" p JOIN appointments a ON a.id=p."appointmentId"
        WHERE ${Prisma.join(where,' AND ')} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${pageOffset}
      ) page ON page."appointmentId"=p."appointmentId" WHERE p.generation=${this.generation} ORDER BY ${order}`):[];
      this.diagnostics.mark('projection-directory-version');
      const projection=q.petId?await tx.directoryProjection.findUnique({where:{kind_id:{kind:'pet',id:q.petId as string}},select:{sourceVersion:true,deletedAt:true}}):null;
      return {appointments,total,counts,projectionVersion:projection&&!projection.deletedAt?projection.sourceVersion:0};
    },{isolationLevel:'RepeatableRead'});
    this.diagnostics.mark('projection-directory');
    const rows=result.appointments,source=rows.length?await directory.lookup(rows.map(r=>r.petId),rows.map(r=>r.ownerId)):{pets:[],owners:[]};
    const pet=q.petId?source.pets.find(p=>p.id===q.petId)??await directory.pet(q.petId as string):null;
    return {items:rows.map(r=>appointmentDto(r,actor)),pagination:{page:q.page,pageSize:q.pageSize,total:result.total,totalPages:Math.ceil(result.total/q.pageSize)},counts:result.counts,
      related:{owners:source.owners,pets:source.pets,appointments:[],medicalRecords:[],medicalImages:[],hotelBookings:[],dailyCareNotes:[],notifications:[],invoices:[]},
      ...(pet?{directory:{petId:pet.id,sourceVersion:pet.directoryVersion,projectionVersion:result.projectionVersion,searchReady:result.projectionVersion>=pet.directoryVersion}}:{}),...(q.q?{searchConsistency:'eventual' as const}:{})};
  }
  async calendar(actor:Actor,{month,category}:AppointmentCalendarQuery){
    if(typeof month!=='string'||!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)||category!==undefined&&!['medical','spa'].includes(String(category)))throw new BusinessError(422,'Invalid month or category.');
    const [y,m]=month.split('-').map(Number);
    const rows=await this.db.$transaction(async tx=>{
      this.diagnostics.mark('projection-plan');
      await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');
      await tx.$executeRawUnsafe("SET LOCAL plan_cache_mode='force_custom_plan'");
      this.diagnostics.mark('projection-calendar');
      const statement=(range:Prisma.Sql)=>Prisma.sql`SELECT p."appointmentDate" AS date,count(*)::int AS n FROM "AppointmentReadRow" p JOIN appointments a ON a.id=p."appointmentId" WHERE ${this.scope(actor)} AND p."appointmentDate">=${new Date(Date.UTC(y!,m!-1,1))} AND p."appointmentDate"<${new Date(Date.UTC(y!,m!,1))} ${category?(category==='spa'?Prisma.sql`AND p.type::text IN (${Prisma.join(spa)})`:Prisma.sql`AND p.type::text NOT IN (${Prisma.join(spa)})`):Prisma.empty} ${range} GROUP BY p."appointmentDate"`;
      if(actor.role!=='owner'){
        const cube=await this.cube(tx,actor),dates=new Map<string,{date:Date;n:number}>();
        for(const row of cube){
          const date=row.date.toISOString().slice(0,10);if(date.slice(0,7)!==month||!this.category(row.type,category))continue;
          const prior=dates.get(date);if(prior)prior.n+=row.n;else dates.set(date,{date:row.date,n:row.n});
        }
        return [...dates.values()];
      }
      return this.aggregate<{date:Date;n:number}[]>(tx,actor,statement(Prisma.empty));
    },{isolationLevel:'RepeatableRead'});
    return Object.fromEntries(rows.map(r=>[r.date.toISOString().slice(0,10),r.n]));
  }
}
