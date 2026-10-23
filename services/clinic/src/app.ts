import express, { type ErrorRequestHandler } from 'express';
import type { PrismaClient } from './generated/client/index.js';
import type { Actor } from './domain/auth.js';
import { BusinessError, StaleRevision } from './domain/error.js';
import type { MedicalRecordValue } from './application/ports/medicalRecords.js';
import { authorize } from './domain/authorization.js';
import { imageRetentionMs } from './blobCleanup.js';
import { objectInput,calendarDate,requiredText } from './domain/validation.js';
import { CoreDirectory, RequestDirectory } from './directory.js';
import { AppointmentService } from './application/services/appointments.js';
import { MedicalRecordsService,medicalFields } from './application/services/medicalRecords.js';
import { appointmentTypes } from './application/ports/appointments.js';
import { BookingLifecycleService } from './application/services/bookingLifecycle.js';
import { appointmentDependencies, medicalDependencies, Lifecycle, medicalMutation } from './infrastructure/persistence/repositories.js';
import { appointmentDto, medicalRecordDto } from './lib/serialize.js';
import { deduplicated } from './dedup.js';
import { list } from './lists.js';
import { selectAppointmentQueries } from './application/queries/appointments.js';
import { AuthoritativeAppointmentQueries } from './infrastructure/queries/authoritativeAppointments.js';
import { ShadowAppointmentQueries } from './infrastructure/queries/shadowAppointments.js';
import { ServingAppointmentQueries } from './infrastructure/queries/servingAppointments.js';
import { ReadFreshness } from './readFreshness.js';
import {readDiagnostics,diagnosticOperation} from './readDiagnostics.js';
import { ReadTokens,committedVersions,type ReadVersions } from './readToken.js';
import {bootstrap} from './bootstrap.js';
import {parseActivityFilter} from './application/queries/clinicActivity.js';
import {ClinicActivityQueries,type SummaryEligibility} from './infrastructure/queries/clinicActivity.js';
import {mountBilling} from './billingApi.js';
import {assertReadProjectionConfig} from './readProjection.js';
import {blobStoreFromEnv,type BlobStore} from './blobStore.js';
import type { ServiceRuntime } from '@nipopeto/runtime';
import { requestActor } from '@nipopeto/runtime';

export function createApp(db:PrismaClient,verify?: (token:string)=>Actor,source?:CoreDirectory,runtime?:ServiceRuntime,readFreshness?:ReadFreshness,activityEvidence?:SummaryEligibility,blobs:BlobStore=blobStoreFromEnv()){
  assertReadProjectionConfig();
  imageRetentionMs(); // AQ-09: an invalid MEDICAL_IMAGE_RETENTION_DAYS fails at startup, not at the first delete
  const app=express();app.disable('x-powered-by');
  const authoritative=new AuthoritativeAppointmentQueries(db);
  // Activity mode is server configuration (fixed or operator control), never a
  // client parameter; it is independent of CLINIC_READ_MODE for lists.
  const activity=new ClinicActivityQueries(db,(process.env.CLINIC_ACTIVITY_MODE??'source') as 'source',undefined,undefined,activityEvidence);
  app.locals.activity=activity;
  const shadow=process.env.CLINIC_READ_MODE==='shadow'?new ShadowAppointmentQueries(authoritative,db,Number(process.env.CLINIC_SHADOW_EVERY??20)):undefined;
  const projected=process.env.CLINIC_READ_MODE==='projection';
  const secret=process.env.CLINIC_READ_TOKEN_SECRET;
  if(projected&&!secret)throw new Error('CLINIC_READ_TOKEN_SECRET_REQUIRED');
  if(secret&&['JWT_SECRET','JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','CORE_DIRECTORY_TOKEN','CLINIC_SERVICE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','RATE_LIMIT_KEY_SECRET','OBSERVABILITY_TOKEN'].some(key=>process.env[key]===secret))throw new Error('DISTINCT_READ_TOKEN_CREDENTIAL_REQUIRED');
  const tokens=secret?new ReadTokens(secret):undefined;
  const slots=Number(process.env.CLINIC_PROJECTION_SLOTS??1);
  const serving=projected?new ServingAppointmentQueries(db,readFreshness??new ReadFreshness(db,undefined,undefined,undefined,{perAggregateLag:true}),undefined,undefined,slots):undefined;
  const appointmentQueries=selectAppointmentQueries(authoritative,projected?'authoritative':process.env.CLINIC_READ_MODE,shadow);
  app.locals.appointmentShadow=shadow;
  app.locals.appointmentServing=serving;
  runtime?.install(app);
  mountBilling(app,db,verify,source);
  app.get('/health/live',(_req,res)=>res.json({service:'clinic',status:'alive'}));
  app.get('/health/ready',async(_req,res)=>{try{await db.appointment.count();await db.medicalRecord.count();await db.medicalImage.count();await db.requestDedup.count();res.json({service:'clinic',status:'ready'});}catch{res.status(503).json({service:'clinic',status:'unavailable'});}});
  const router=express.Router();
  router.use('/dashboard/clinic/activity',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  app.use('/internal/clinic', (req,res,next)=>{if(req.path!=='/bootstrap'||req.method!=='GET'){res.status(404).json({error:'Clinic route not found.'});return;}if(!source||!source.acceptsService(req.headers['x-service-token'],'bootstrap')){res.status(401).json({error:'Service authentication required.'});return;}next();});
  router.use((req,res,next)=>{if(!verify||!source){res.status(503).json({error:'Clinic authentication or directory is not configured.'});return;}const bearer=req.headers.authorization;if(!bearer?.startsWith('Bearer ')||bearer.length>8192){res.status(401).json({error:'Authentication required.'});return;}try{res.locals.actor=requestActor(req,verify);next();}catch{res.status(401).json({error:'Invalid or expired token.'});}});
  router.use(express.json({limit:'8mb'}));
  router.use((req,_res,next)=>{if(req.path==='/dashboard/clinic/activity')authorize(_res.locals.actor,'clinic-activity.read');next();});
  router.use(async(req,res,next)=>{
    const actor=res.locals.actor as Actor;
    if(req.path.startsWith('/medical-records')&&req.method!=='GET')authorize(actor,'medical-record.write');
    if(req.body===undefined&&['POST','PATCH','PUT'].includes(req.method))req.body={};
    if(req.body!==undefined)objectInput(req.body);
    const petIds:string[]=[];
    const add=(v:unknown)=>{if(v!==undefined&&v!==null&&v!==''){if(typeof v!=='string'||v.length>200)throw new BusinessError(422,'Invalid pet ID.');petIds.push(v);}};
    if(req.method==='GET'){if(req.path!=='/dashboard/clinic/activity'){const id=typeof req.query.petId==='string'?req.query.petId.trim():req.query.petId;if(id!=='all')add(id);}}else add(req.path==='/medical-records'&&typeof req.body?.petId==='string'?req.body.petId.trim():req.body?.petId);
    const match=req.path.match(/^\/(appointments|medical-records)\/(?:images\/)?([^/]+)(?:\/|$)/);
    if(match&&!['calendar','images'].includes(match[2]!)){
      const id=decodeURIComponent(match[2]!);
      let row:{petId:string}|null=match[1]==='appointments'?await db.appointment.findUnique({where:{id}}):req.path.startsWith('/medical-records/images/')?await db.medicalImage.findUnique({where:{id},select:{petId:true}}):await db.medicalRecord.findUnique({where:{id}});
      // AQ-15: history outlives a deleted record; scope it by the pet in its last snapshot.
      if(!row&&req.method==='GET'&&req.path===`/medical-records/${match[2]}/history`){
        const last=await db.medicalRecordRevision.findFirst({where:{recordId:id},orderBy:[{changedAt:'desc'},{id:'desc'}]});
        const snapshot=(last?.before??last?.after) as {petId?:unknown}|null|undefined;
        if(typeof snapshot?.petId==='string')row={petId:snapshot.petId};
      }
      if(!row)throw new BusinessError(404,'Clinic resource not found.');add(row.petId);
    }
    const token=req.headers.authorization!.slice(7),snapshot=await source!.request(actor,token,{petIds:[...new Set(petIds)],...(req.body?.doctorId?{doctorId:req.body.doctorId}:{})});
    res.locals.directory=new RequestDirectory(source!,actor,token,snapshot);next();
  });
  const appointment=(res:express.Response,bound?:Parameters<typeof appointmentDependencies>[2])=>new AppointmentService(appointmentDependencies(db,res.locals.directory,bound),new BookingLifecycleService(new Lifecycle(db,res.locals.directory,bound)));
  const medical=(res:express.Response,bound?:Parameters<typeof medicalDependencies>[3])=>new MedicalRecordsService(medicalDependencies(db,res.locals.directory,blobs,bound));
  const read=async(req:express.Request,res:express.Response,run:(reader:typeof appointmentQueries)=>Promise<unknown>)=>readDiagnostics.run(diagnosticOperation(res.locals.actor.role==='owner',req.path.endsWith('/calendar'),req.query),async diagnosticId=>{
    if(diagnosticId!==undefined)res.setHeader('X-Clinic-Read-Diagnostic-Id',String(diagnosticId));
    res.setHeader('Cache-Control','no-store');
    const header=req.headers['x-clinic-min-version'];
    if(header!==undefined&&!tokens)throw Object.assign(new BusinessError(422,'Clinic read tokens are not configured.'),{code:'CLINIC_READ_TOKEN_INVALID'});
    const versions=tokens?.verify(header,res.locals.actor)??{};
    const consistency=req.headers['x-clinic-read-consistency'];
    if(consistency!==undefined&&consistency!=='authoritative')throw new BusinessError(422,'Invalid Clinic read consistency.');
    if(serving){const result=await serving.read(run,versions,consistency==='authoritative'||req.query.mode==='unbilled');res.setHeader('X-Clinic-Read-Source',result.source);if(result.generation)res.setHeader('X-Clinic-Projection-Generation',result.generation);if(result.degraded)res.setHeader('X-Service-Degraded','clinic-read');res.json(result.data);}
    else{res.setHeader('X-Clinic-Read-Source','authoritative');res.json(await run(appointmentQueries));}
  });
  const sendMutation=(res:express.Response,result:{response:unknown;versions:ReadVersions},status=200)=>{
    res.setHeader('Cache-Control','no-store');
    if(tokens&&Object.keys(result.versions).length)res.setHeader('X-Clinic-Read-Token',tokens.issue(res.locals.actor,result.versions));
    res.status(status).json(result.response);
  };
  router.get('/appointments',async(req,res)=>read(req,res,reader=>reader.list(res.locals.actor,res.locals.directory,req.query)));
  router.get('/appointments/calendar',async(req,res)=>read(req,res,reader=>reader.calendar(res.locals.actor,{month:req.query.month,category:req.query.category})));
  router.post('/appointments',async(req,res)=>{
    const result=await deduplicated(db,res.locals.actor.sub,'appointment.create',req.headers['idempotency-key'],normalizeCreate(req.body,false),async tx=>{const row=await appointment(res,tx).create(res.locals.actor,req.body);return{resourceId:row.id,appointmentId:row.id,response:{appointment:appointmentDto(row,res.locals.actor.role==='owner')}};},true);sendMutation(res,result as {response:unknown;versions:ReadVersions},201);
  });
  const change=async(req:express.Request,res:express.Response,action:'changeStatus'|'reschedule'|'cancel'|'undoStatus')=>{
    const result=await db.$transaction(async tx=>{const row=await appointment(res,tx)[action](res.locals.actor,String(req.params.id),req.body??{});return {response:{appointment:appointmentDto(row,res.locals.actor.role==='owner')},versions:await committedVersions(tx,row.id)};});sendMutation(res,result);
  };
  router.patch('/appointments/:id/status',async(req,res)=>change(req,res,'changeStatus'));
  router.patch('/appointments/:id/reschedule',async(req,res)=>change(req,res,'reschedule'));
  router.patch('/appointments/:id/cancel',async(req,res)=>change(req,res,'cancel'));
  router.get('/appointments/:id/status-history',async(req,res)=>res.json(await appointment(res).history(res.locals.actor,req.params.id)));
  router.post('/appointments/:id/undo-status',async(req,res)=>change(req,res,'undoStatus'));
  router.post('/appointments/:id/reminder',async(req,res)=>{await appointment(res).sendReminder(res.locals.actor,req.params.id);res.status(201).json({message:'Reminder request accepted.'});});
  router.get('/medical-records',async(req,res)=>res.json(await list(db,'medicalRecords',res.locals.actor,res.locals.directory,req.query)));
  router.post('/medical-records',async(req,res)=>{const result=await deduplicated(db,res.locals.actor.sub,'medical-record.create',req.headers['idempotency-key'],normalizeCreate(req.body,true),async tx=>{const row=await medical(res,tx).create(res.locals.actor,req.body);return{resourceId:row.id,appointmentId:row.appointmentId,response:{record:medicalRecordDto(row)}};},true);sendMutation(res,result as {response:unknown;versions:ReadVersions},201);});
  router.patch('/medical-records/:id',async(req,res)=>res.json({record:medicalRecordDto(await medicalMutation(db,req.params.id,tx=>medical(res,tx).update(res.locals.actor,req.params.id,req.body??{})))}));
  router.delete('/medical-records/:id',async(req,res)=>{await medicalMutation(db,req.params.id,tx=>medical(res,tx).delete(res.locals.actor,req.params.id,req.query.expectedRevision));res.status(204).end();});
  router.get('/medical-records/:id/history',async(req,res)=>res.json({items:await medical(res).history(res.locals.actor,req.params.id)}));
  router.get('/medical-records/images',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await list(db,'medicalImages',res.locals.actor,res.locals.directory,req.query,blobs));});
  router.post('/medical-records/images',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.status(201).json({image:await medical(res).createImage(res.locals.actor,req.body)});});
  router.delete('/medical-records/images/:id',async(req,res)=>{await medical(res).deleteImage(res.locals.actor,req.params.id);res.status(204).end();});
  router.post('/medical-records/images/:id/restore',async(req,res)=>{await medical(res).restoreImage(res.locals.actor,req.params.id);res.status(204).end();});
  router.get('/bootstrap',async(req,res)=>res.json(await bootstrap(db,res.locals.actor,res.locals.directory,req.query.view)));
  router.get('/dashboard/clinic',async(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({...await bootstrap(db,res.locals.actor,res.locals.directory,'dashboard'),asOf:new Date().toISOString()});});
  router.get('/dashboard/clinic/activity',async(req,res)=>{
    // Express also matches trailing slashes/case variants; authorize the matched
    // operation itself, independently of the early exact-path rejection above.
    authorize(res.locals.actor,'clinic-activity.read');
    const filter=parseActivityFilter(req.query);
    try{const result=await activity.read(filter);res.setHeader('X-Clinic-Read-Source',result.meta.source);if(result.meta.generation)res.setHeader('X-Clinic-Projection-Generation',result.meta.generation);if(result.meta.degraded)res.setHeader('X-Service-Degraded','clinic-activity');res.json(result);}
    catch(error){if(error instanceof BusinessError)throw error;throw new BusinessError(503,'Clinic activity is unavailable. Retry later.');}
  });
  app.use('/internal/clinic',router);
  // Internal compatibility data is never reachable through the public router.
  app.use('/api/bootstrap',(_req,res)=>res.status(404).json({error:'Clinic route not found.'}));
  app.use('/api',router);
  app.use((_req,res)=>res.status(404).json({error:'Clinic route not found.'}));
  // A stale medical record edit returns the stored record, so the editor can keep its draft and show what changed.
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{if(res.headersSent){res.end();return;}if(error instanceof BusinessError){if(error.status===503)res.setHeader('Retry-After','1');res.status(error.status).json({error:error.message,...(error.code?{code:error.code}:{}),...(error instanceof StaleRevision?{current:medicalRecordDto(error.current as MedicalRecordValue)}:{})});}else if(error?.type==='entity.parse.failed')res.status(400).json({error:'Invalid JSON.'});else if(error?.type==='entity.too.large')res.status(413).json({error:'Request too large.'});else if(error?.code==='P2025')res.status(404).json({error:'Clinic resource not found.'});else res.status(503).json({error:'Clinic unavailable. Retry the same request key.'});};app.use(errors);return app;
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
