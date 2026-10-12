import {Prisma} from '@prisma/client';
import {Prisma as Clinic} from '../../services/clinic/src/generated/client/index.js';
import {Prisma as Notification} from '../../services/notification/src/generated/client/index.js';
import {createHash} from 'node:crypto';
import {ident} from './p7-environment.mjs';

const coreNames=['User','OwnerActivation','Pet','HotelBooking','HotelBookingRequest','BookingStatusEvent','DailyCareNote','RescueReport','Invoice','InvoiceItem','PaymentAttempt','PaymentEvent','OutboxEvent','AppointmentBillingOperation'];
const clinicNames=['Appointment','MedicalRecord','MedicalImage','BookingStatusEvent','AppointmentReservation','AppointmentBillingTerminal','DirectoryProjection','InboxEvent'];
const descriptors=p=>Object.fromEntries(p.dmmf.datamodel.models.map(m=>[m.name,{model:m.name,table:m.dbName??m.name,fields:m.fields.filter(f=>f.kind!=='object').map(f=>({name:f.name,column:f.dbName??f.name,type:f.type,required:f.isRequired,list:f.isList,...(f.kind==='enum'?{enumValues:p.dmmf.datamodel.enums.find(e=>e.name===f.type).values.map(v=>v.name)}:{})})),keys:m.fields.some(f=>f.isId)?m.fields.filter(f=>f.isId).map(f=>f.dbName??f.name):(m.primaryKey?.fields??[]).map(name=>m.fields.find(f=>f.name===name)?.dbName??name)}]));
export const catalogs={source:descriptors(Prisma),core:descriptors(Prisma),clinic:descriptors(Clinic),notification:descriptors(Notification)};
export const sourceNames=[...coreNames.slice(0,3),'Appointment','MedicalRecord','MedicalImage',...coreNames.slice(3),'Notification'];
if(new Set(sourceNames).size!==Object.keys(catalogs.source).length)throw new Error('P7_UNCLASSIFIED_SOURCE_MODEL');
export const targets={core:coreNames,clinic:clinicNames,notification:['Notification','InboxEvent']};
export const sourceOwner=name=>['Appointment','MedicalRecord','MedicalImage'].includes(name)?'clinic':name==='Notification'?'notification':name==='BookingStatusEvent'?'split(kind)':'core';
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
export function rowKey(descriptor,row){return JSON.stringify(descriptor.keys.map(k=>row[k]));}
export function sortRows(descriptor,rows){return [...rows].sort((a,b)=>rowKey(descriptor,a).localeCompare(rowKey(descriptor,b),'en'));}
export async function readRows(db,descriptor){
  const dateColumns=['appointment_date','visit_date','follow_up_date','check_in','check_out','note_date'];
  const expressions=descriptor.fields.map(f=>{const c='t.'+ident(f.column);return `'${f.column}',`+(f.type==='Decimal'?c+'::text':f.type==='DateTime'?`to_char(${c},'${dateColumns.includes(f.column)?'YYYY-MM-DD':'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'}')`:f.type==='Json'?`CASE WHEN ${c} IS NULL THEN NULL ELSE jsonb_build_object('value',${c}) END`:c);}).join(',');
  const rows=await db.$queryRawUnsafe(`SELECT jsonb_build_object(${expressions}) AS row FROM runtime.${ident(descriptor.table)} t`);
  return sortRows(descriptor,rows.map(r=>r.row));
}
export async function insertRows(db,descriptor,rows){
  const columns=descriptor.fields.map(f=>ident(f.column)).join(','),select=descriptor.fields.map(f=>f.type==='Json'?`($1::jsonb->'${f.column}'->'value')`:'r.'+ident(f.column)).join(',');
  const ordered=[],remaining=new Map(rows.map(r=>[rowKey(descriptor,r),r])),done=new Set();
  while(remaining.size){let advanced=false;for(const [key,row]of remaining){if(row.reverses_id&&remaining.has(JSON.stringify([row.reverses_id]))&&!done.has(row.reverses_id))continue;ordered.push(row);done.add(row.id);remaining.delete(key);advanced=true;}if(!advanced)throw new Error('P7_HISTORY_REVERSAL_CYCLE');}
  for(const row of ordered)await db.$executeRawUnsafe(`INSERT INTO runtime.${ident(descriptor.table)} (${columns}) SELECT ${select} FROM jsonb_populate_record(NULL::runtime.${ident(descriptor.table)},$1::jsonb) r`,JSON.stringify(row));
}
export function reportTable(descriptor,rows){return {count:rows.length,keysHash:digest(sortRows(descriptor,rows).map(r=>rowKey(descriptor,r))),contentHash:digest(sortRows(descriptor,rows)),fields:descriptor.fields.map(f=>f.column)};}
export const convert=(row,from,to)=>Object.fromEntries(to.fields.map(f=>{const src=from.fields.find(s=>s.name===f.name);return [f.column,src?row[src.column]:null];}));
