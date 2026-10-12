import express from 'express';
import {createHash,timingSafeEqual} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import {requireAuth} from '../middleware/auth.js';
import {BusinessError} from '../domain/error.js';
import {AppointmentInvoiceBilling,ClinicBillingRemote} from './appointmentBilling.js';
import {currentRequestId} from '@nipopeto/runtime';

export function mountAppointmentBilling(app:express.Express,db:PrismaClient,clinic:URL,credential:string,evidenceCredential=credential){
  const billing=new AppointmentInvoiceBilling(db,new ClinicBillingRemote(clinic,credential));
  const safe=(work:(req:express.Request,res:express.Response)=>Promise<void>)=>async(req:express.Request,res:express.Response)=>{try{await work(req,res);}catch(e){if(res.headersSent)return;if(e instanceof BusinessError)res.status(e.status).json({error:e.message});else res.status(503).json({error:'Billing temporarily unavailable. Retry the same request key.'});}};
  app.get('/internal/billing-operations/:operationId',safe(async(req,res)=>{
    const token=req.headers['x-service-token'];if(typeof token!=='string'||token.length>512||!timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(evidenceCredential).digest())){res.status(401).json({error:'Service authentication required.'});return;}
    const op=await billing.read(req.params.operationId as string);res.json({operationId:op.id,state:op.state,appointmentId:op.appointmentId,invoiceId:op.invoiceId});
  }));
  app.get('/api/operations/:id',requireAuth,safe(async(req,res)=>{
    await billing.actor(req.auth!);const op=await billing.read(req.params.id as string);if(op.actorId!==req.auth!.sub||op.actorRole!==req.auth!.role)throw new BusinessError(404,'Operation not found.');res.setHeader('Cache-Control','no-store');res.json(await billing.result(op));
  }));
  for(const [path,self] of [['/api/invoices',false],['/api/invoices/checkout',true]] as const){
    app.post(path,express.json({limit:'96kb'}),(req,res,next)=>{
      if(req.body?.type!=='appointment'&&!req.body?.appointmentId){next();return;}
      requireAuth(req,res,()=>void safe(async(req,res)=>{
        const op=await billing.begin(req.auth!,req.body,req.headers['idempotency-key'],self);
        let timer:ReturnType<typeof setTimeout>|undefined;
        const running=billing.resume(op.id);
        // A request deadline ends waiting, not the durable operation. The same
        // row/lock still determines commit vs abort if work finishes afterward.
        let outcome;try{outcome=await Promise.race([running,new Promise<typeof op>(resolve=>{timer=setTimeout(()=>resolve(op),4500);})]);}finally{if(timer)clearTimeout(timer);}
        const result=await billing.result(outcome);
        if(process.env.PHASE2_RUNTIME_REQUIRED==='1')process.stdout.write(JSON.stringify({service:'core',requestId:currentRequestId()??null,operationId:op.id,status:result.status})+'\n');
        if(res.headersSent)return;
        res.setHeader('Cache-Control','no-store');
        if(result.status==='pending'){res.setHeader('Location','/api/operations/'+op.id);res.setHeader('Retry-After','1');res.status(202).json(result);}
        else if(result.status==='failed')res.status(result.errorStatus!).json({error:result.error,operationId:op.id,status:'failed'});
        else res.status(self?200:201).json({invoice:result.invoice});
      })(req,res));
    });
  }
  return billing;
}
