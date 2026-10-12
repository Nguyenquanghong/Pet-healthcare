import express, { type ErrorRequestHandler } from 'express';
import type { PrismaClient } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError } from './domain/error.js';
import { objectInput,calendarDate,requiredText } from './domain/validation.js';
import { CoreDirectory, RequestDirectory } from './directory.js';
import { AppointmentService } from './application/services/appointments.js';
import { MedicalRecordsService,medicalFields } from './application/services/medicalRecords.js';
import { appointmentTypes } from './application/ports/appointments.js';
import { BookingLifecycleService } from './application/services/bookingLifecycle.js';
import { appointmentDependencies, medicalDependencies, Lifecycle, medicalMutation } from './infrastructure/persistence/repositories.js';
import { appointmentDto, medicalRecordDto } from './lib/serialize.js';
import { deduplicated } from './dedup.js';
import { list,calendar } from './lists.js';
import {bootstrap} from './bootstrap.js';
import {mountBilling} from './billingApi.js';
import type { ServiceRuntime } from '@nipopeto/runtime';

export function createApp(db:PrismaClient,verify?: (token:string)=>Actor,source?:CoreDirectory,runtime?:ServiceRuntime){
  const app=express();app.disable('x-powered-by');
  runtime?.install(app);
  mountBilling(app,db,verify,source);
  app.get('/health/live',(_req,res)=>res.json({service:'clinic',status:'alive'}));
  app.get('/health/ready',async(_req,res)=>{try{await db.appointment.count();await db.medicalRecord.count();await db.medicalImage.count();await db.requestDedup.count();res.json({service:'clinic',status:'ready'});}catch{res.status(503).json({service:'clinic',status:'unavailable'});}});
  const router=express.Router();
  app.use('/internal/clinic', (req,res,next)=>{if(req.path!=='/bootstrap'||req.method!=='GET'){res.status(404).json({error:'Clinic route not found.'});return;}if(!source||!source.acceptsService(req.headers['x-service-token'],'bootstrap')){res.status(401).json({error:'Service authentication required.'});return;}next();});
  router.use((req,res,next)=>{if(!verify||!source){res.status(503).json({error:'Clinic authentication or directory is not configured.'});return;}const bearer=req.headers.authorization;if(!bearer?.startsWith('Bearer ')||bearer.length>8192){res.status(401).json({error:'Authentication required.'});return;}try{res.locals.actor=verify(bearer.slice(7));next();}catch{res.status(401).json({error:'Invalid or expired token.'});}});
  router.use(express.json({limit:'8mb'}));
  router.use(async(req,res,next)=>{
    const actor=res.locals.actor as Actor;
    if(actor.role==='owner'&&req.path.startsWith('/medical-records')&&req.method!=='GET')throw new BusinessError(403,'Staff access is required.');
    if(req.body===undefined&&['POST','PATCH','PUT'].includes(req.method))req.body={};
    if(req.body!==undefined)objectInput(req.body);
    const petIds:string[]=[];
    const add=(v:unknown)=>{if(v!==undefined&&v!==null&&v!==''){if(typeof v!=='string'||v.length>200)throw new BusinessError(422,'Invalid pet ID.');petIds.push(v);}};
    if(req.method==='GET'){const id=typeof req.query.petId==='string'?req.query.petId.trim():req.query.petId;if(id!=='all')add(id);}else add(req.path==='/medical-records'&&typeof req.body?.petId==='string'?req.body.petId.trim():req.body?.petId);
    const match=req.path.match(/^\/(appointments|medical-records)\/(?:images\/)?([^/]+)(?:\/|$)/);
    if(match&&!['calendar','images'].includes(match[2]!)){
      const id=decodeURIComponent(match[2]!);
      const row=match[1]==='appointments'?await db.appointment.findUnique({where:{id}}):req.path.startsWith('/medical-records/images/')?await db.medicalImage.findUnique({where:{id}}):await db.medicalRecord.findUnique({where:{id}});
      if(!row)throw new BusinessError(404,'Clinic resource not found.');add(row.petId);
    }
    const token=req.headers.authorization!.slice(7),snapshot=await source!.request(actor,token,{petIds:[...new Set(petIds)],...(req.body?.doctorId?{doctorId:req.body.doctorId}:{})});
    res.locals.directory=new RequestDirectory(source!,actor,token,snapshot);next();
  });
  const appointment=(res:express.Response,bound?:Parameters<typeof appointmentDependencies>[2])=>new AppointmentService(appointmentDependencies(db,res.locals.directory,bound),new BookingLifecycleService(new Lifecycle(db,res.locals.directory,bound)));
  const medical=(res:express.Response,bound?:Parameters<typeof medicalDependencies>[2])=>new MedicalRecordsService(medicalDependencies(db,res.locals.directory,bound));
  router.get('/appointments',async(req,res)=>res.json(await list(db,'appointments',res.locals.actor,res.locals.directory,req.query)));
  router.get('/appointments/calendar',async(req,res)=>res.json(await calendar(db,res.locals.actor,req.query.month,req.query.category)));
  router.post('/appointments',async(req,res)=>{
    const response=await deduplicated(db,res.locals.actor.sub,'appointment.create',req.headers['idempotency-key'],normalizeCreate(req.body,false),async tx=>{const row=await appointment(res,tx).create(res.locals.actor,req.body);return{resourceId:row.id,response:{appointment:appointmentDto(row,res.locals.actor.role==='owner')}};});res.status(201).json(response);
  });
  router.patch('/appointments/:id/status',async(req,res)=>res.json({appointment:appointmentDto(await appointment(res).changeStatus(res.locals.actor,req.params.id,req.body??{}),res.locals.actor.role==='owner')}));
  router.patch('/appointments/:id/reschedule',async(req,res)=>res.json({appointment:appointmentDto(await appointment(res).reschedule(res.locals.actor,req.params.id,req.body??{}),res.locals.actor.role==='owner')}));
  router.patch('/appointments/:id/cancel',async(req,res)=>res.json({appointment:appointmentDto(await appointment(res).cancel(res.locals.actor,req.params.id,req.body??{}),res.locals.actor.role==='owner')}));
  router.get('/appointments/:id/status-history',async(req,res)=>res.json(await appointment(res).history(res.locals.actor,req.params.id)));
  router.post('/appointments/:id/undo-status',async(req,res)=>res.json({appointment:appointmentDto(await appointment(res).undoStatus(res.locals.actor,req.params.id,req.body??{}),res.locals.actor.role==='owner')}));
  router.post('/appointments/:id/reminder',async(req,res)=>{await appointment(res).sendReminder(res.locals.actor,req.params.id);res.status(201).json({message:'Reminder request accepted.'});});
  router.get('/medical-records',async(req,res)=>res.json(await list(db,'medicalRecords',res.locals.actor,res.locals.directory,req.query)));
  router.post('/medical-records',async(req,res)=>{const response=await deduplicated(db,res.locals.actor.sub,'medical-record.create',req.headers['idempotency-key'],normalizeCreate(req.body,true),async tx=>{const row=await medical(res,tx).create(res.locals.actor,req.body);return{resourceId:row.id,response:{record:medicalRecordDto(row)}};});res.status(201).json(response);});
  router.patch('/medical-records/:id',async(req,res)=>res.json({record:medicalRecordDto(await medicalMutation(db,req.params.id,tx=>medical(res,tx).update(res.locals.actor,req.params.id,req.body??{})))}));
  router.delete('/medical-records/:id',async(req,res)=>{await medicalMutation(db,req.params.id,tx=>medical(res,tx).delete(res.locals.actor,req.params.id));res.status(204).end();});
  router.get('/medical-records/images',async(req,res)=>res.json(await list(db,'medicalImages',res.locals.actor,res.locals.directory,req.query)));
  router.post('/medical-records/images',async(req,res)=>res.status(201).json({image:await medical(res).createImage(res.locals.actor,req.body)}));
  router.delete('/medical-records/images/:id',async(req,res)=>{await medical(res).deleteImage(res.locals.actor,req.params.id);res.status(204).end();});
  router.get('/bootstrap',async(req,res)=>res.json(await bootstrap(db,res.locals.actor,res.locals.directory,req.query.view)));
  router.get('/dashboard/clinic',async(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({...await bootstrap(db,res.locals.actor,res.locals.directory,'dashboard'),asOf:new Date().toISOString()});});
  app.use('/internal/clinic',router);
  // Internal compatibility data is never reachable through the public router.
  app.use('/api/bootstrap',(_req,res)=>res.status(404).json({error:'Clinic route not found.'}));
  app.use('/api',router);
  app.use((_req,res)=>res.status(404).json({error:'Clinic route not found.'}));
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{if(res.headersSent){res.end();return;}if(error instanceof BusinessError)res.status(error.status).json({error:error.message});else if(error?.type==='entity.parse.failed')res.status(400).json({error:'Invalid JSON.'});else if(error?.type==='entity.too.large')res.status(413).json({error:'Request too large.'});else if(error?.code==='P2025')res.status(404).json({error:'Clinic resource not found.'});else res.status(503).json({error:'Clinic unavailable. Retry the same request key.'});};app.use(errors);return app;
}
// Hash only fields the use case consumes, with its defaults/trim semantics.
function normalizeCreate(input:Record<string,unknown>,record:boolean){
  if(record)return{petId:requiredText(input.petId,'Pet',200),...medicalFields(input)};
  const names=record?['petId','appointmentId','doctorName','visitDate','title','symptoms','diagnosis','treatment','medications','vaccineName','followUpDate','weightKg','temperatureC','heartRateBpm','internalNote']:['petId','type','date','time','serviceName','doctorId','clinicName','ownerNote'];
  const value:Record<string,unknown>={};for(const k of names){const v=input[k];value[k]=typeof v==='string'?(record||['serviceName','ownerNote'].includes(k)?v.trim():v):v??null;}
  if(!record){value.type=value.type||'other';value.clinicName=value.clinicName||'Nippon Pet Care';value.ownerNote=value.ownerNote||null;value.doctorId=value.doctorId||null;}
  if(!appointmentTypes.includes(value.type as typeof appointmentTypes[number])||typeof value.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))throw new BusinessError(422,'Invalid appointment service or time.');
  calendarDate(value.date,'Appointment date');requiredText(value.serviceName,'Service');
  // Calendar validation stays independent of current time: a committed retry
  // remains replayable tomorrow. The use case checks Vietnam today on creation.
  for(const k of ['doctorId','clinicName','ownerNote'])if(value[k]!==null&&typeof value[k]!=='string')throw new BusinessError(422,`Invalid ${k}.`);
  return value;
}
