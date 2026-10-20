import {Prisma} from './generated/client/index.js';

// SQL names are static metadata; all runtime values are bound parameters.
export const appointmentFields={petId:'pet_id',ownerId:'owner_id',doctorId:'doctor_id',type:'type',serviceName:'service_name',clinicName:'clinic_name',appointmentDate:'appointment_date',appointmentTime:'appointment_time',status:'status',statusRevision:'status_revision',ownerNote:'owner_note',internalNote:'internal_note',createdBy:'created_by',createdAt:'created_at',updatedAt:'updated_at'} as const;
export const sourceColumns=Prisma.raw(Object.entries(appointmentFields).map(([field,column])=>`a."${column}" AS "${field}"`).join(','));
export const readColumns=Prisma.raw(Object.keys(appointmentFields).map(field=>`p."${field}"`).join(','));
export const billingColumns=Prisma.sql`EXISTS(SELECT 1 FROM "AppointmentReservation" b WHERE b."appointmentId"=a.id AND b.state='HELD') AS "billingHeld", EXISTS(SELECT 1 FROM "AppointmentReservation" b WHERE b."appointmentId"=a.id AND b.state='INVOICED') AS "billingInvoiced"`;
export const sourceSnapshot=Prisma.sql`SELECT a.id AS "appointmentId",r.version AS "sourceVersion",${sourceColumns},${billingColumns} FROM appointments a JOIN "ClinicReadRevision" r ON r.kind='appointment' AND r."aggregateId"=a.id AND NOT r.deleted`;

export async function reconcileProjection(tx:Prisma.TransactionClient,generation:string,ownerId?:string){
  // Compare full allowlisted data as JSONB, not only count or version. Source
  // existence and ownership are independent of potentially stale projection ACL.
  const [result]=await tx.$queryRaw<{missing:number;extra:number;lag:number;ahead:number;corrupt:number;registry:number}[]>(Prisma.sql`
    WITH s AS (${sourceSnapshot}), p AS (SELECT "appointmentId","sourceVersion",${Prisma.raw(Object.keys(appointmentFields).map(f=>`"${f}"`).join(','))},"billingHeld","billingInvoiced","deletedAt" FROM "AppointmentReadRow" WHERE generation=${generation})
    SELECT count(*) FILTER(WHERE p."appointmentId" IS NULL AND s."appointmentId" IS NOT NULL)::int AS missing,
      count(*) FILTER(WHERE s."appointmentId" IS NULL AND p."appointmentId" IS NOT NULL)::int AS extra,
      count(*) FILTER(WHERE p."sourceVersion"<s."sourceVersion")::int AS lag,
      count(*) FILTER(WHERE p."sourceVersion">s."sourceVersion")::int AS ahead,
      count(*) FILTER(WHERE p."sourceVersion"=s."sourceVersion" AND (p."deletedAt" IS NOT NULL OR (to_jsonb(p)-'deletedAt') IS DISTINCT FROM to_jsonb(s)))::int AS corrupt,
      (SELECT count(*)::int FROM appointments a FULL JOIN (SELECT * FROM "ClinicReadRevision" WHERE kind='appointment') r ON r."aggregateId"=a.id WHERE ((a.id IS NOT NULL AND (r.version IS NULL OR r.deleted)) OR (a.id IS NULL AND NOT r.deleted)) ${ownerId?Prisma.sql`AND a.owner_id=${ownerId}`:Prisma.empty}) AS registry
    FROM s FULL JOIN p USING("appointmentId") ${ownerId?Prisma.sql`WHERE s."ownerId"=${ownerId} OR p."ownerId"=${ownerId}`:Prisma.empty}`);
  return result!;
}
