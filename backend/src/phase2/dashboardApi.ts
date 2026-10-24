import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../domain/auth.js';
import { BusinessError } from '../domain/error.js';
import { requireAuth } from '../middleware/auth.js';
import { BootstrapService } from '../application/services/bootstrap.js';
import { PrismaBootstrapRepository } from '../infrastructure/persistence/bootstrapRepository.js';
import { ownerDto, petDto, hotelBookingDto, appointmentDto, medicalRecordDto } from '../lib/serialize.js';

export async function currentActor(db:PrismaClient,actor:Actor) {
  const user=await db.user.findUnique({where:{id:actor.sub},select:{role:true}});
  if(!user||user.role!==actor.role)throw new BusinessError(403,'Current account permission is required.');
}
export function mountDashboards(app:Express,db:PrismaClient,splitClinic:boolean) {
  const local=new BootstrapService(new PrismaBootstrapRepository(db,true,true));
  app.get('/api/dashboard/core',requireAuth,async(req,res)=>{
    try {
      await currentActor(db,req.auth!);
      const d=await local.load(req.auth!,'dashboard');
      res.setHeader('Cache-Control','no-store');
      res.json({asOf:new Date().toISOString(),owners:d.owners.map(ownerDto),pets:d.pets.map(petDto),hotelBookings:d.hotelBookings.map(r=>hotelBookingDto(r,req.auth!)),
        summary:{totals:{owners:d.summary.totals.owners,pets:d.summary.totals.pets,hotelBookings:d.summary.totals.hotelBookings,dailyCareNotes:d.summary.totals.dailyCareNotes},species:d.summary.species,hotelStatus:d.summary.hotelStatus}});
    }catch(e){res.status(e instanceof BusinessError?e.status:503).json({error:e instanceof BusinessError?e.message:'Core dashboard unavailable.'});}
  });
  // Opt-in split mode never reads clinical tables at Core. Legacy mode remains
  // usable until the explicitly authorized P7 cutover.
  if(!splitClinic)app.get('/api/dashboard/clinic',requireAuth,async(req,res)=>{
    try {
      await currentActor(db,req.auth!);
      const d=await new BootstrapService(new PrismaBootstrapRepository(db,false,true)).load(req.auth!,'dashboard');
      res.setHeader('Cache-Control','no-store');
      res.json({asOf:new Date().toISOString(),owners:d.owners.map(ownerDto),pets:d.pets.map(petDto),appointments:d.appointments.map(r=>appointmentDto(r,req.auth!)),medicalRecords:d.medicalRecords.map(r=>medicalRecordDto(r,req.auth!.role==='owner')),medicalImages:[],summary:{totals:{appointments:d.summary.totals.appointments,medicalRecords:d.summary.totals.medicalRecords,medicalImages:d.summary.totals.medicalImages},appointmentStatus:d.summary.appointmentStatus,todayAppointments:d.summary.todayAppointments}});
    }catch(e){res.status(e instanceof BusinessError?e.status:503).json({error:e instanceof BusinessError?e.message:'Clinic dashboard unavailable.'});}
  });
}
