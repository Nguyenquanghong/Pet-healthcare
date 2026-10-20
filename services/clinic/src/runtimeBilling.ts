import type { PrismaClient, Prisma } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import type { BillingSourceSnapshot, CoreState } from '@nipopeto/contracts';
import {recordAppointmentChange} from './readRevision.js';

function permitted(actor: Actor, ownerId: string) {
  if (actor.role === 'owner' && actor.sub !== ownerId) throw new BusinessError(404, 'Billing source not found.');
}
export class AppointmentBilling {
  constructor(private readonly db: PrismaClient) {}
  async source(appointmentId: string, actor: Actor): Promise<BillingSourceSnapshot> {
    const a = await this.db.appointment.findUnique({ where: { id: appointmentId } });
    if (!a) throw new BusinessError(404, 'Billing source not found.');
    permitted(actor, a.ownerId);
    if (a.status !== 'completed') throw new BusinessError(409, 'Appointment must be completed.');
    return { appointmentId:a.id,ownerId:a.ownerId,petId:a.petId,revision:a.statusRevision,type:a.type,
      serviceName:a.serviceName,clinicName:a.clinicName,date:a.appointmentDate.toISOString().slice(0,10),time:a.appointmentTime };
  }
  async prepare(operationId: string, appointmentId: string, revision: number, actor: Actor, afterLock?:()=>Promise<void>) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > 2147483647) throw new BusinessError(422, 'Invalid source revision.');
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id=${appointmentId} FOR UPDATE`;
      await afterLock?.();
      const a=await tx.appointment.findUnique({where:{id:appointmentId}});
      if(!a)throw new BusinessError(404,'Billing source not found.');
      permitted(actor,a.ownerId);
      const terminal=await tx.appointmentBillingTerminal.findUnique({where:{operationId}});
      if(terminal?.state==='ABORTED')throw new BusinessError(409,'Operation has been aborted.');
      const old=await tx.appointmentReservation.findUnique({where:{operationId}});
      if(old){
        if(old.appointmentId!==appointmentId||old.revisionAtPrepare!==revision||old.state==='RELEASED')throw new BusinessError(409,'Reservation operation reuse.');
        return old.snapshot as unknown as BillingSourceSnapshot;
      }
      if(a.status!=='completed'||a.statusRevision!==revision)throw new BusinessError(409,'Appointment revision or status changed.');
      if(await tx.appointmentReservation.findFirst({where:{appointmentId,state:{in:['HELD','INVOICED']}}}))throw new BusinessError(409,'Appointment is already reserved or invoiced.');
      const snapshot:BillingSourceSnapshot={appointmentId:a.id,ownerId:a.ownerId,petId:a.petId,revision:a.statusRevision,type:a.type,serviceName:a.serviceName,clinicName:a.clinicName,date:a.appointmentDate.toISOString().slice(0,10),time:a.appointmentTime};
      await tx.appointmentReservation.create({data:{operationId,appointmentId,revisionAtPrepare:revision,snapshot:snapshot as unknown as Prisma.InputJsonValue}});
      await recordAppointmentChange(tx,appointmentId);
      return snapshot;
    });
  }
  async reconcile(operationId:string,evidence:{state:CoreState;appointmentId:string;invoiceId?:string|null}){
    if(evidence.state==='PREPARING')return this.db.appointmentReservation.findUnique({where:{operationId}});
    const terminal={...evidence,state:evidence.state};
    return this.db.$transaction(tx=>applyBillingTerminal(tx,operationId,terminal));
  }
}

// Inbox and authenticated HTTP reconciliation use the same lock and state guard.
// Abort tombstone is retained even if delayed prepare has not created HELD yet.
export async function applyBillingTerminal(tx:Prisma.TransactionClient,operationId:string,evidence:{state:'COMMITTED'|'ABORTED';appointmentId:string;invoiceId?:string|null}){
  await tx.$queryRaw`SELECT id FROM appointments WHERE id=${evidence.appointmentId} FOR UPDATE`;
  const old=await tx.appointmentBillingTerminal.findUnique({where:{operationId}});
  if(old&&(old.appointmentId!==evidence.appointmentId||old.state!==evidence.state||old.invoiceId!==(evidence.invoiceId??null)))throw new Error('BILLING_TERMINAL_CONFLICT');
  const r=await tx.appointmentReservation.findUnique({where:{operationId}});
  const state=evidence.state==='COMMITTED'?'INVOICED':'RELEASED';
  if(evidence.state==='COMMITTED'&&(!r||!evidence.invoiceId))throw new Error('BILLING_RESERVATION_REQUIRED');
  if(r&&(r.appointmentId!==evidence.appointmentId||r.state!=='HELD'&&(r.state!==state||r.invoiceId!==(evidence.invoiceId??null))))throw new Error('BILLING_TERMINAL_CONFLICT');
  if(!old)await tx.appointmentBillingTerminal.create({data:{operationId,appointmentId:evidence.appointmentId,state:evidence.state,invoiceId:evidence.invoiceId??null}});
  if(r?.state==='HELD'){
    const saved=await tx.appointmentReservation.update({where:{operationId},data:{state,invoiceId:evidence.invoiceId??null}});
    await recordAppointmentChange(tx,evidence.appointmentId);return saved;
  }
  return r;
}
