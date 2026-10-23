import {createHash,randomUUID} from 'node:crypto';
import {Prisma,type PrismaClient,type AppointmentBillingOperation} from '@prisma/client';
import {traceHeaders} from '@nipopeto/runtime';
import type {BillingSourceSnapshot,Envelope} from '@nipopeto/contracts';
import type {Actor} from '../domain/auth.js';
import {BusinessError} from '../domain/error.js';
import {authorize} from '../domain/authorization.js';
import {money,lines} from '../application/services/invoices.js';
import type {InvoiceLine,InvoiceValue} from '../application/ports/invoices.js';
import pricing from '../domain/pricing.json' with {type:'json'};
import {signToken} from '../lib/token.js';
import {invoiceDto} from '../lib/serialize.js';
import {writeNotification} from '../infrastructure/persistence/notificationOutbox.js';

type Fees={relatedId:string;items?:InvoiceLine[];subtotal?:number;taxAmount:number;discountAmount:number;notes:string|null;expectedRevision?:number};
function fees(input:Record<string,unknown>,self:boolean):Fees{
  if(!input||Array.isArray(input)||input.type!=='appointment'||typeof input.relatedId!=='string'||!input.relatedId.trim()||input.relatedId.length>128)throw new BusinessError(422,'Invalid appointment billing source.');
  if(self&&Object.keys(input).some(k=>!['type','relatedId'].includes(k)))throw new BusinessError(422,'Prices are calculated by the server.');
  if(input.notes!==undefined&&(typeof input.notes!=='string'||input.notes.length>2000))throw new BusinessError(422,'Invalid invoice notes.');
  if(input.expectedRevision!==undefined&&(!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0||Number(input.expectedRevision)>2147483647))throw new BusinessError(422,'Invalid source revision.');
  return{relatedId:input.relatedId.trim(),...(!self?(input.items===undefined?{subtotal:money(input.subtotal,'Subtotal')}:{items:lines(input.items)}):{}),taxAmount:money(input.taxAmount??0,'Tax'),discountAmount:money(input.discountAmount??0,'Discount'),notes:typeof input.notes==='string'?input.notes.trim()||null:null,...(input.expectedRevision!==undefined?{expectedRevision:Number(input.expectedRevision)}:{})};
}
function charges(input:Fees,s:BillingSourceSnapshot,self:boolean){
  const rate=pricing.fixedSpaRates[s.type as keyof typeof pricing.fixedSpaRates];
  if(self&&!rate)throw new BusinessError(409,'This service requires staff to settle charges.');
  const items=self?[{description:s.serviceName,quantity:1,unitPrice:rate!,amount:rate!}]:input.items??[{description:s.serviceName,quantity:1,unitPrice:input.subtotal!,amount:input.subtotal!}];
  if(!items.length)throw new BusinessError(422,'Invoice requires at least one service.');
  const subtotal=money(items.reduce((n,l)=>n+l.amount,0),'Subtotal');
  if(input.discountAmount>subtotal)throw new BusinessError(422,'Discount exceeds subtotal.');
  const totalAmount=money(subtotal+input.taxAmount-input.discountAmount,'Total');
  if(totalAmount<=0)throw new BusinessError(422,'Invoice total must be positive.');
  return{items,subtotal,taxAmount:input.taxAmount,discountAmount:input.discountAmount,totalAmount,notes:input.notes};
}
export type BillingRemote={source:(id:string,actor:Actor)=>Promise<BillingSourceSnapshot>;prepare:(operation:AppointmentBillingOperation,actor:Actor)=>Promise<BillingSourceSnapshot>;finalize:(operation:AppointmentBillingOperation)=>Promise<void>};
export class ClinicBillingRemote implements BillingRemote{
  constructor(private readonly origin:URL,private readonly credential:string,private readonly timeout=1800){if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||credential.length<32||credential.length>512||!Number.isInteger(timeout)||timeout<100||timeout>5000)throw new Error('INVALID_BILLING_REMOTE_CONFIGURATION');}
  private async call(path:string,method:string,actor?:Actor,body?:unknown){
    try{const res=await fetch(new URL(path,this.origin),{method,headers:{...traceHeaders(),'X-Service-Token':this.credential,...(actor?{Authorization:'Bearer '+signToken(actor.sub,actor.role)}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(this.timeout)});
      if([403,404,409,422].includes(res.status))throw new BusinessError(res.status as 403|404|409|422,'Clinic rejected the billing source.');
      if(res.status!==200)throw new Error();return await res.json();
    }catch(e){if(e instanceof BusinessError)throw e;throw new BusinessError(503,'Clinic billing temporarily unavailable.');}
  }
  private snapshot(value:any,id:string):BillingSourceSnapshot{
    const s=value?.snapshot;if(!s||s.appointmentId!==id||!Number.isSafeInteger(s.revision)||s.revision<0||!['ownerId','petId','type','serviceName','clinicName','date','time'].every(k=>typeof s[k]==='string'&&s[k].length>0&&s[k].length<=2000)||!/^\d{4}-\d\d-\d\d$/.test(s.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)||Object.keys(s).some(k=>!['appointmentId','revision','ownerId','petId','type','serviceName','clinicName','date','time'].includes(k)))throw new BusinessError(503,'Invalid Clinic billing snapshot.');return s;
  }
  async source(id:string,actor:Actor){return this.snapshot(await this.call('/internal/billing-sources/'+encodeURIComponent(id),'GET',actor),id);}
  async prepare(op:AppointmentBillingOperation,actor:Actor){const s=this.snapshot(await this.call('/internal/billing-reservations/'+encodeURIComponent(op.id),'PUT',actor,{appointmentId:op.appointmentId,expectedRevision:op.expectedRevision}),op.appointmentId);if(s.revision!==op.expectedRevision)throw new BusinessError(503,'Reservation revision mismatch.');return s;}
  async finalize(op:AppointmentBillingOperation){await this.call('/internal/billing-reservations/'+encodeURIComponent(op.id)+(op.state==='COMMITTED'?'/commit':'/release'),'POST',undefined,{});}
}

export class AppointmentInvoiceBilling{
  constructor(private readonly db:PrismaClient,private readonly remote:BillingRemote){}
  async actor(actor:Actor){const current=await this.db.user.findUnique({where:{id:actor.sub},select:{role:true}});if(!current||current.role!==actor.role)throw new BusinessError(403,'Current actor role is required.');}
  async begin(actor:Actor,input:Record<string,unknown>,key:unknown,self=false){
    await this.actor(actor);
    authorize(actor,self?'billing.self-service':'billing.manage');
    if(typeof key!=='string'||!key.trim()||key!==key.trim()||key.length>128)throw new BusinessError(422,'Idempotency-Key is required (maximum 128 characters).');
    const payload=fees(input,self),operationType=self?'invoice.checkout':'invoice.create';
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.db.$transaction(async tx=>{
      await tx.$executeRaw`INSERT INTO "AppointmentBillingOperation" (id,"actorId","actorRole","operationType","idempotencyKey","requestHash","appointmentId",payload,"expectedRevision","updatedAt") VALUES (${randomUUID()},${actor.sub},${actor.role},${operationType},${key},${hash},${payload.relatedId},${JSON.stringify(payload)}::jsonb,${payload.expectedRevision??null},now()) ON CONFLICT DO NOTHING`;
      const op=await tx.appointmentBillingOperation.findUnique({where:{actorId_operationType_idempotencyKey:{actorId:actor.sub,operationType,idempotencyKey:key}}});
      if(!op)throw new BusinessError(409,'Appointment billing is already pending.');
      if(op.requestHash!==hash)throw new BusinessError(409,'Request key was used with different charges.');return op;
    });
  }
  async read(id:string){if(typeof id!=='string'||!id||id.length>128)throw new BusinessError(422,'Invalid operation ID.');const operation=await this.db.appointmentBillingOperation.findUnique({where:{id}});if(!operation)throw new BusinessError(404,'Operation not found.');return operation;}
  async terminal(id:string,action:'commit'|'abort',snapshot?:BillingSourceSnapshot,error?:{status:number;code:string},fault?:()=>void,afterLock?:()=>Promise<void>){
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "AppointmentBillingOperation" WHERE id=${id} FOR UPDATE`;
      await afterLock?.();
      const op=await tx.appointmentBillingOperation.findUniqueOrThrow({where:{id}});
      if(op.state!=='PREPARING')return op;
      let invoiceId:string|undefined;
      let existingCheckout=false;
      if(action==='commit'){
        if(!snapshot||snapshot.appointmentId!==op.appointmentId||snapshot.revision!==op.expectedRevision)throw new BusinessError(409,'A prepared reservation is required.');
        const old=op.operationType==='invoice.checkout'?await tx.invoice.findUnique({where:{appointmentId:op.appointmentId}}):null;
        if(old&&old.ownerId!==op.actorId)throw new BusinessError(404,'Billing source not found.');
        if(old){invoiceId=old.id;existingCheckout=true;}else{
          const c=charges(op.payload as unknown as Fees,snapshot,op.operationType==='invoice.checkout');
          const {items,...data}=c;
          const invoice=await tx.invoice.create({data:{...data,id:randomUUID(),invoiceCode:'INV-'+randomUUID(),type:'appointment',ownerId:snapshot.ownerId,petId:snapshot.petId,appointmentId:op.appointmentId,sourceSnapshot:snapshot as unknown as Prisma.InputJsonValue,items:{create:items}},include:{items:true}});invoiceId=invoice.id;
          await writeNotification(tx,{recipientOwnerId:snapshot.ownerId,recipientRole:'owner',type:'invoice_requested',title:'Yêu cầu thanh toán',message:`Hóa đơn ${invoice.invoiceCode}: ${c.totalAmount.toLocaleString('vi-VN')} VND. Vui lòng kiểm tra các khoản phí.`,actionUrl:'/owner/billing'});
        }
      }
      const updated=await tx.appointmentBillingOperation.update({where:{id},data:{state:action==='commit'?'COMMITTED':'ABORTED',invoiceId:invoiceId??null,snapshot:snapshot? snapshot as unknown as Prisma.InputJsonValue:undefined,terminalAt:new Date(),...(existingCheckout?{finalizedAt:new Date()}:{}),errorStatus:error?.status,errorCode:error?.code}});
      if(existingCheckout)return updated; // Baseline checkout returns an already-issued invoice; no new reservation/event/notice.
      const event:Envelope={eventId:randomUUID(),eventType:action==='commit'?'billing.invoice-issued.v1':'billing.operation-aborted.v1',schemaVersion:1,producer:'core',aggregateType:'billing-operation',aggregateId:id,aggregateVersion:1,occurredAt:new Date().toISOString(),correlationId:id,payload:{operationId:id,appointmentId:op.appointmentId,...(invoiceId?{invoiceId}:{})}};
      await tx.outboxEvent.create({data:{id:event.eventId,envelope:event as unknown as Prisma.InputJsonValue}});fault?.();return updated;
    });
  }
  async resume(id:string){
    let op=await this.read(id);if(op.state!=='PREPARING')return op;
    try{
      const actor:Actor={sub:op.actorId,role:op.actorRole as Actor['role']};await this.actor(actor);
      if(op.operationType==='invoice.checkout'){
        const old=await this.db.invoice.findUnique({where:{appointmentId:op.appointmentId}});
        if(old){if(old.ownerId!==actor.sub)throw new BusinessError(404,'Billing source not found.');if(!old.sourceSnapshot)throw new BusinessError(503,'Historical invoice snapshot requires migration.');const s=old.sourceSnapshot as unknown as BillingSourceSnapshot;if(op.expectedRevision===null)await this.db.appointmentBillingOperation.updateMany({where:{id,state:'PREPARING',expectedRevision:null},data:{expectedRevision:s.revision}});return this.terminal(id,'commit',s);}
      }
      if(op.expectedRevision===null){const source=await this.remote.source(op.appointmentId,actor);await this.db.appointmentBillingOperation.updateMany({where:{id,state:'PREPARING',expectedRevision:null},data:{expectedRevision:source.revision}});op=await this.read(id);if(op.state!=='PREPARING')return op;}
      const snapshot=await this.remote.prepare(op,actor);
      const pet=await this.db.pet.findUnique({where:{id:snapshot.petId},select:{ownerId:true}});
      const owner=await this.db.user.findUnique({where:{id:snapshot.ownerId},select:{role:true}});
      if(!pet||pet.ownerId!==snapshot.ownerId||owner?.role!=='owner'||actor.role==='owner'&&snapshot.ownerId!==actor.sub)throw new BusinessError(404,'Billing source owner is unavailable.');
      return await this.terminal(id,'commit',snapshot);
    }catch(e){
      if(e instanceof BusinessError&&e.status!==503)return this.terminal(id,'abort',undefined,{status:e.status,code:e.message});
      if((e as {code?:string}).code==='P2002')return this.terminal(id,'abort',undefined,{status:409,code:'Appointment already has an invoice.'});
      // A network/DB error is unknown. Retain operation and reservation for retry.
      return this.read(id);
    }
  }
  async result(op:AppointmentBillingOperation){
    if(op.state==='COMMITTED'){const invoice=await this.db.invoice.findUniqueOrThrow({where:{id:op.invoiceId!},include:{items:true}});return{operationId:op.id,status:'succeeded' as const,invoiceId:invoice.id,invoice:invoiceDto(invoice)};}
    if(op.state==='ABORTED')return{operationId:op.id,status:'failed' as const,error:op.errorCode??'Operation aborted.',errorStatus:op.errorStatus??409};
    return{operationId:op.id,status:'pending' as const};
  }
  async reconcileOnce(workerId:string,limit=8,operationId?:string){
    if(!Number.isInteger(limit)||limit<1||limit>32)throw new Error('INVALID_RECONCILE_BATCH');
    const ids=await this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM "AppointmentBillingOperation" WHERE (${operationId??null}::text IS NULL OR id=${operationId??null}) AND "finalizedAt" IS NULL AND "nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      for(const r of rows)await tx.appointmentBillingOperation.update({where:{id:r.id},data:{leaseOwner:workerId,leaseUntil:new Date(Date.now()+30000),attempts:{increment:1}}});return rows;
    });
    for(const {id} of ids){try{
      const op=await this.resume(id);
      if(op.state!=='PREPARING'){await this.remote.finalize(op);await this.db.appointmentBillingOperation.updateMany({where:{id,leaseOwner:workerId},data:{finalizedAt:new Date()}});}
    }catch{/* Safe retry metadata only; never print URLs, actor tokens or snapshots. */}
    finally{const op=await this.read(id);await this.db.appointmentBillingOperation.updateMany({where:{id,leaseOwner:workerId},data:{leaseOwner:null,leaseUntil:null,nextAttemptAt:new Date(Date.now()+Math.min(60000,500*2**Math.min(op.attempts,7)))}});}}
    return ids.length;
  }
}
