import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import {requireAuth} from '../middleware/auth.js';
import {BootstrapService} from '../application/services/bootstrap.js';
import {PrismaBootstrapRepository} from '../infrastructure/persistence/bootstrapRepository.js';
import {ownerDto,petDto,hotelBookingDto,careNoteDto} from '../lib/serialize.js';
import {BusinessError} from '../domain/error.js';
import {currentActor} from './dashboardApi.js';
import {traceHeaders} from '@nipopeto/runtime';

export function mountSplitBootstrap(app:Express,db:PrismaClient,clinic:URL,credential:string,notificationUrl?:string){
  const local=new BootstrapService(new PrismaBootstrapRepository(db,true,true));
  // Temporary adapter for old callers. The P5 frontend has no bootstrap caller.
  app.get('/api/bootstrap',requireAuth,async(req,res)=>{
    try{
      const actor=req.auth!,view=req.query.view??'session';
      if(view!=='session'&&view!=='dashboard')throw new BusinessError(422,'Invalid bootstrap view.');
      await currentActor(db,actor);
      const get=async(url:URL,headers:Record<string,string>)=>{const r=await fetch(url,{headers:{...traceHeaders(),...headers},redirect:'error',signal:AbortSignal.timeout(4000)});if(!r.ok)throw new Error('REGION_UNAVAILABLE');return r.json();};
      const clinicRegion=(value:any)=>{if(!value||!Array.isArray(value.appointments)||!Array.isArray(value.medicalRecords)||!Array.isArray(value.pets)||!Array.isArray(value.owners)||!value.summary?.totals)throw new Error('INVALID_CLINIC_REGION');return value;};
      const notificationRegion=(value:any)=>{if(!value||!Array.isArray(value.items)||!Number.isSafeInteger(value.pagination?.total)||value.pagination.total<0||!value.counts||typeof value.counts!=='object'||Array.isArray(value.counts))throw new Error('INVALID_NOTIFICATION_REGION');return value;};
      const url=new URL('/internal/clinic/bootstrap',clinic);url.searchParams.set('view',view);
      const [own,clinical,notices]=await Promise.allSettled([
        local.load(actor,view),get(url,{Authorization:req.headers.authorization!,'X-Service-Token':credential}).then(clinicRegion),
        notificationUrl?get(new URL('/api/notifications?pageSize='+ (view==='dashboard'?'5':'1'),notificationUrl),{Authorization:req.headers.authorization!}).then(notificationRegion):Promise.reject(new Error('REGION_NOT_CONFIGURED'))
      ]);
      if(own.status!=='fulfilled')throw new Error('CORE_REGION_UNAVAILABLE');
      const data=own.value,remote=clinical.status==='fulfilled'?clinical.value:null,notice=notices.status==='fulfilled'?notices.value:null;
      const asOf=new Date().toISOString();
      if(res.headersSent)return;
      res.setHeader('Cache-Control','no-store');
      res.json({...data,owners:[...new Map([...data.owners.map(ownerDto),...(remote?.owners??[])].map(r=>[r.id,r])).values()],pets:[...new Map([...data.pets.map(petDto),...(remote?.pets??[])].map(r=>[r.id,r])).values()],
        appointments:remote?.appointments??[],medicalRecords:remote?.medicalRecords??[],medicalImages:remote?.medicalImages??[],
        hotelBookings:data.hotelBookings.map(r=>hotelBookingDto(r,actor.role==='owner')),dailyCareNotes:data.dailyCareNotes.map(careNoteDto),notifications:view==='dashboard'?(notice?.items??[]):[],
        summary:{...data.summary,totals:{...data.summary.totals,appointments:remote?.summary.totals.appointments??null,medicalRecords:remote?.summary.totals.medicalRecords??null,medicalImages:remote?.summary.totals.medicalImages??null,notifications:notice?.pagination.total??null},
          unread:notice?notice.counts.sent??0:null,notificationCategory:notice?Object.fromEntries(Object.entries(notice.counts).filter(([k])=>k.startsWith('category:')&&k!=='category:all').map(([k,v])=>[k.slice(9),v])):{},
          appointmentStatus:remote?.summary.appointmentStatus??{},todayAppointments:remote?.summary.todayAppointments??null},
        regions:{core:{status:'available',asOf},clinic:{status:remote?'available':'unavailable',asOf:remote?asOf:null},notifications:{status:notice?'available':'unavailable',asOf:notice?asOf:null}}});
    }catch(error){if(!res.headersSent)res.status(error instanceof BusinessError?error.status:503).json({error:error instanceof BusinessError?error.message:'Bootstrap unavailable.'});}
  });
}
