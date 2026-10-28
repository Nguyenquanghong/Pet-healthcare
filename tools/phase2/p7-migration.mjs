import {readProvenance} from './source-provenance.mjs';
import {parseEnvelope} from '@nipopeto/contracts';
import {assertContext,withDatabase,withCutoverLock,ident} from './p7-environment.mjs';
import {catalogs,targets,sourceNames,sourceOwner,digest,sortRows,readRows,insertRows,reportTable,convert} from './p7-manifest.mjs';

const fail=(condition,code)=>{if(!condition)throw new Error('P7_'+code);};
const wrapped=value=>({value});
const money=value=>{fail(typeof value==='string'&&/^\d{1,10}\.00$/.test(value),'INVALID_VND');return BigInt(value.replace('.',''));};
export const seal=body=>({...body,sha256:digest(body)});
export function verifySnapshot(snapshot,ctx){
  assertContext(ctx);const {sha256,...body}=snapshot??{};
  fail(body.version===1&&body.run===ctx.run&&body.source?.database===ctx.components.legacy.database&&body.source.schema==='runtime','INVALID_SNAPSHOT_SCOPE');
  fail(sha256===digest(body),'SNAPSHOT_CHECKSUM');
  fail(typeof body.exportedAt==='string'&&Number.isFinite(Date.parse(body.exportedAt))&&new Date(body.exportedAt).toISOString()===body.exportedAt,'INVALID_EXPORT_TIMESTAMP');
  fail(body.evidence&&typeof body.evidence==='object'&&!Array.isArray(body.evidence)&&(!body.evidence.notificationEvents||typeof body.evidence.notificationEvents==='object'&&!Array.isArray(body.evidence.notificationEvents)),'INVALID_REVIEW_EVIDENCE');
  fail(digest(Object.keys(body.tables??{}).sort())===digest([...sourceNames].sort()),'UNCLASSIFIED_SOURCE_MODEL');
  let bytes=0;
  for(const name of sourceNames){const d=catalogs.source[name],rows=body.tables[name];fail(Array.isArray(rows)&&rows.length<=100000,'SNAPSHOT_SIZE_LIMIT');bytes+=JSON.stringify(rows).length;
    fail(new Set(rows.map(r=>JSON.stringify(d.keys.map(k=>r[k])))).size===rows.length,'DUPLICATE_ID');
    for(const r of rows){fail(digest(Object.keys(r).sort())===digest(d.fields.map(f=>f.column).sort()),'UNCLASSIFIED_SOURCE_FIELD');for(const f of d.fields){const v=r[f.column];fail(!f.required||v!==null,'MISSING_REQUIRED_FIELD');if(v===null)continue;
      const values=f.list?(fail(Array.isArray(v),'INVALID_LIST'),v):[v];for(const value of values){if(f.type==='String')fail(typeof value==='string','INVALID_STRING');if(f.type==='Int')fail(Number.isSafeInteger(value),'INVALID_INTEGER');if(f.type==='Boolean')fail(typeof value==='boolean','INVALID_BOOLEAN');if(f.type==='Decimal')fail(typeof value==='string'&&/^-?\d+\.\d+$/.test(value),'INVALID_DECIMAL');if(f.enumValues)fail(f.enumValues.includes(value),'INVALID_ENUM');}
      if(f.type==='DateTime'){fail(typeof v==='string'&&Number.isFinite(Date.parse(v)),'INVALID_DATE');fail(v.length===10?new Date(v).toISOString().slice(0,10)===v:new Date(v).toISOString()===v,'INVALID_DATE');}
      if(f.type==='Json')fail(typeof v==='object'&&Object.keys(v).length===1&&Object.hasOwn(v,'value'),'INVALID_JSON_TRANSPORT');}}
  }fail(bytes<=32*1024*1024,'SNAPSHOT_SIZE_LIMIT');
  return body;
}
export async function exportMigration(ctx,{evidence={},component='legacy'}={}){
  fail(['legacy','restore'].includes(component),'INVALID_EXPORT_SOURCE');
  return withDatabase(ctx,component,db=>db.$transaction(async tx=>{
    const [gate]=await tx.$queryRaw`SELECT state FROM public.p7_cutover WHERE id=1`;fail(['FROZEN','IMPORTED'].includes(gate?.state),'FROZEN_SOURCE_REQUIRED');
    const tables={};for(const name of sourceNames)tables[name]=await readRows(tx,catalogs.source[name]);
    const schema=await tx.$queryRaw`SELECT table_name,column_name,data_type,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='runtime' ORDER BY table_name,ordinal_position`;
    fail(digest([...new Set(schema.map(c=>c.table_name))].sort())===digest([...sourceNames.map(n=>catalogs.source[n].table),'_prisma_migrations'].sort()),'UNCLASSIFIED_DATABASE_TABLE');
    for(const name of sourceNames){const d=catalogs.source[name];fail(digest(schema.filter(c=>c.table_name===d.table).map(c=>c.column_name).sort())===digest(d.fields.map(f=>f.column).sort()),'UNCLASSIFIED_DATABASE_FIELD');}
    const indexes=await tx.$queryRaw`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='runtime' ORDER BY tablename,indexname`;
    const foreignKeys=await tx.$queryRaw`SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='runtime' AND c.contype='f' ORDER BY 1,2`;
    const migrations=await tx.$queryRaw`SELECT migration_name,checksum FROM runtime."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    const [sequence]=await tx.$queryRaw`SELECT last_value::text,is_called FROM runtime.invoice_transfer_code_seq`;
    const provenance=readProvenance();
    const body={version:1,run:ctx.run,source:{database:ctx.components.legacy.database,schema:'runtime',...provenance,timezone:'Asia/Ho_Chi_Minh',migrations,columns:schema,indexes,foreignKeys,sequence},exportedAt:new Date().toISOString(),evidence,tables};
    const snapshot=seal(body);buildMigration(snapshot,ctx);return snapshot;
  },{isolationLevel:'RepeatableRead',timeout:30000}),{admin:true});
}
export function buildMigration(snapshot,ctx){
  const s=verifySnapshot(snapshot,ctx),t=s.tables,out={core:{},clinic:{},notification:{}},at=s.exportedAt;
  const map=name=>new Map(t[name].map(r=>[r.id,r])),users=map('User'),pets=map('Pet'),appointments=map('Appointment'),hotels=map('HotelBooking'),invoices=map('Invoice');
  const owner=(id,petId)=>fail(users.get(id)?.role==='owner'&&pets.get(petId)?.owner_id===id,'OWNER_PET_ORPHAN');
  for(const p of t.Pet)fail(users.get(p.owner_id)?.role==='owner','PET_OWNER_ORPHAN');
  for(const a of t.Appointment){owner(a.owner_id,a.pet_id);fail(!a.doctor_id||users.get(a.doctor_id)?.role==='doctor','DOCTOR_ORPHAN');fail(/^([01]\d|2[0-3]):[0-5]\d$/.test(a.appointment_time),'INVALID_TIME');}
  const slots=new Set();for(const a of t.Appointment.filter(a=>!['cancelled','no_show'].includes(a.status))){const key=[a.pet_id,a.appointment_date,a.appointment_time].join('|');fail(!slots.has(key),'DUPLICATE_SLOT');slots.add(key);}
  for(const r of t.MedicalRecord){owner(r.owner_id,r.pet_id);if(r.appointment_id){const a=appointments.get(r.appointment_id);fail(a&&a.pet_id===r.pet_id&&a.owner_id===r.owner_id&&a.status==='completed','MEDICAL_APPOINTMENT_ORPHAN');}}
  for(const image of t.MedicalImage)fail(pets.has(image.pet_id),'IMAGE_PET_ORPHAN');
  for(const h of t.HotelBooking){owner(h.owner_id,h.pet_id);fail(h.check_out>h.check_in&&Number.isSafeInteger(h.nights)&&h.nights>0&&((Date.parse(h.check_out)-Date.parse(h.check_in))/86400000===h.nights),'INVALID_HOTEL_DATES');money(h.total_amount);}
  for(const r of t.HotelBookingRequest)fail(hotels.has(r.booking_id)&&users.has(r.actor_id),'HOTEL_REQUEST_ORPHAN');
  for(const r of t.OwnerActivation)fail(users.get(r.owner_id)?.role==='owner'&&users.has(r.issued_by),'ACTIVATION_ORPHAN');
  for(const r of t.RescueReport)fail(pets.has(r.pet_id),'RESCUE_ORPHAN');
  for(const r of t.DailyCareNote)fail(hotels.has(r.booking_id),'CARE_ORPHAN');
  const histories=map('BookingStatusEvent'),revisions=new Set();
  for(const h of t.BookingStatusEvent){const parent=h.kind==='appointment'?appointments.get(h.booking_id):h.kind==='hotel'?hotels.get(h.booking_id):null;
    fail(parent&&h.revision>0&&h.revision<=parent.status_revision,'HISTORY_KIND_OR_REVISION');const key=[h.kind,h.booking_id,h.revision].join('|');fail(!revisions.has(key),'DUPLICATE_HISTORY_REVISION');revisions.add(key);
    if(h.reverses_id){const previous=histories.get(h.reverses_id);fail(previous&&previous.kind===h.kind&&previous.booking_id===h.booking_id&&previous.revision<h.revision,'HISTORY_REVERSAL_SCOPE');}
  }
  for(const a of [...t.Appointment,...t.HotelBooking]){const kind=appointments.has(a.id)?'appointment':'hotel',hs=t.BookingStatusEvent.filter(h=>h.kind===kind&&h.booking_id===a.id);if(a.status_revision>0){const last=hs.find(h=>h.revision===a.status_revision);fail(last&&last.to_status===a.status,'HISTORY_LAST_STATE');}}
  const billed=new Set();for(const i of t.Invoice){owner(i.owner_id,i.pet_id);fail(money(i.subtotal)+money(i.tax_amount)-money(i.discount_amount)===money(i.total_amount),'INVOICE_TOTAL');
    fail(['appointment','hotel_booking'].includes(i.type)&&Boolean(i.appointment_id)!==Boolean(i.hotel_booking_id),'INVOICE_SOURCE_KIND');
    const parent=i.type==='appointment'?appointments.get(i.appointment_id):hotels.get(i.hotel_booking_id);fail(parent&&parent.owner_id===i.owner_id&&parent.pet_id===i.pet_id,'INVOICE_SOURCE_ORPHAN');
    const key=i.type+':'+(i.appointment_id??i.hotel_booking_id);fail(!billed.has(key),'DUPLICATE_SOURCE_INVOICE');billed.add(key);
  }
  for(const r of [...t.InvoiceItem,...t.PaymentAttempt,...t.PaymentEvent])fail(invoices.has(r.invoice_id),'FINANCIAL_ORPHAN');
  for(const item of t.InvoiceItem)fail(Number.isSafeInteger(item.quantity)&&item.quantity>0&&money(item.unit_price)*BigInt(item.quantity)===money(item.amount),'ITEM_AMOUNT');
  for(const i of t.Invoice)fail(t.InvoiceItem.filter(r=>r.invoice_id===i.id).reduce((sum,r)=>sum+money(r.amount),0n)===money(i.subtotal),'INVOICE_ITEM_TOTAL');
  for(const p of t.PaymentAttempt){fail(money(p.amount)===money(invoices.get(p.invoice_id).total_amount),'PAYMENT_AMOUNT');fail(['pending','succeeded','failed','review'].includes(p.status),'PAYMENT_STATUS');}
  for(const n of t.Notification){fail(['sent','read'].includes(n.status),'NOTIFICATION_STATUS');fail(n.recipient_role==='owner'?users.get(n.recipient_owner_id)?.role==='owner':n.recipient_role==='admin'&&n.recipient_owner_id===null,'NOTIFICATION_RECIPIENT');}
  const pendingOps=t.AppointmentBillingOperation.filter(o=>o.state==='PREPARING'||o.finalizedAt===null);fail(!pendingOps.length,'DRAIN_BILLING_BEFORE_MIGRATION');
  for(const e of t.OutboxEvent){fail(e.leaseOwner===null&&e.leaseUntil===null,'DRAIN_OUTBOX_LEASES');const envelope=parseEnvelope(JSON.stringify(e.envelope.value));fail(envelope.eventId===e.id,'OUTBOX_EVENT_ID');}
  for(const name of targets.core)out.core[name]=structuredClone(t[name]);
  out.core.BookingStatusEvent=t.BookingStatusEvent.filter(r=>r.kind==='hotel');
  out.clinic.Appointment=structuredClone(t.Appointment);
  // P02/P11: imported records start at revision 0; no trustworthy doctor name -> id mapping, so doctor_id stays NULL.
  out.clinic.MedicalRecord=t.MedicalRecord.map(row=>({...structuredClone(row),doctor_id:null,revision:0}));
  // AQ-09: imported images keep their base64 claim-less form; the blob migration tool moves them later.
  out.clinic.MedicalImage=t.MedicalImage.map(row=>({...row,owner_id:pets.get(row.pet_id).owner_id,storage_key:null,size_bytes:null,sha256:null,deleted_at:null,deleted_by:null}));
  out.clinic.BookingStatusEvent=t.BookingStatusEvent.filter(r=>r.kind==='appointment');
  out.clinic.AppointmentReservation=[];out.clinic.AppointmentBillingTerminal=[];
  for(const invoice of out.core.Invoice.filter(i=>i.appointment_id)){
    const a=appointments.get(invoice.appointment_id);fail(a.status==='completed','BILLED_APPOINTMENT_STATE');
    const existing=t.AppointmentBillingOperation.find(o=>o.state==='COMMITTED'&&o.invoiceId===invoice.id);
    let snap=invoice.source_snapshot?.value??existing?.snapshot?.value;
    if(!snap){fail(Date.parse(a.updated_at)<=Date.parse(invoice.issued_at)&&!t.BookingStatusEvent.some(h=>h.kind==='appointment'&&h.booking_id===a.id&&Date.parse(h.created_at)>Date.parse(invoice.issued_at)),'HISTORICAL_SNAPSHOT_REVIEW_REQUIRED');snap={appointmentId:a.id,ownerId:a.owner_id,petId:a.pet_id,revision:a.status_revision,type:a.type,serviceName:a.service_name,clinicName:a.clinic_name,date:a.appointment_date,time:a.appointment_time};}
    fail(snap.appointmentId===a.id&&snap.ownerId===invoice.owner_id&&snap.petId===invoice.pet_id&&Number.isSafeInteger(snap.revision),'SNAPSHOT_SOURCE_CONFLICT');
    invoice.source_snapshot=wrapped(snap);
    const operationId=existing?.id??'legacy-invoice:'+invoice.id;
    if(!existing)out.core.AppointmentBillingOperation.push({id:operationId,actorId:invoice.owner_id,actorRole:'owner',operationType:'invoice.checkout',idempotencyKey:'p7-backfill:'+invoice.id,requestHash:digest({legacyInvoice:invoice.id}),appointmentId:a.id,expectedRevision:snap.revision,payload:wrapped({type:'appointment',relatedId:a.id}),state:'COMMITTED',invoiceId:invoice.id,snapshot:wrapped(snap),errorCode:null,errorStatus:null,createdAt:invoice.created_at,updatedAt:invoice.updated_at,terminalAt:invoice.issued_at,finalizedAt:invoice.issued_at,attempts:0,nextAttemptAt:invoice.created_at,leaseOwner:null,leaseUntil:null});
    out.clinic.AppointmentReservation.push({operationId,appointmentId:a.id,revisionAtPrepare:snap.revision,snapshot:wrapped(snap),state:'INVOICED',invoiceId:invoice.id,createdAt:invoice.issued_at,updatedAt:invoice.issued_at});
    out.clinic.AppointmentBillingTerminal.push({operationId,appointmentId:a.id,state:'COMMITTED',invoiceId:invoice.id,createdAt:invoice.issued_at});
  }
  for(const o of t.AppointmentBillingOperation.filter(o=>o.state==='ABORTED'))out.clinic.AppointmentBillingTerminal.push({operationId:o.id,appointmentId:o.appointmentId,state:'ABORTED',invoiceId:null,createdAt:o.terminalAt??o.updatedAt});
  out.clinic.DirectoryProjection=[...t.User.map(u=>({kind:u.role==='owner'?'owner':'staff',id:u.id,sourceVersion:u.directory_revision,displayName:u.full_name,ownerId:null,species:null,phone:u.role==='owner'?u.phone:null,breed:null,email:u.role==='owner'?u.email:null,microchipId:null,updatedAt:u.updated_at,deletedAt:null})),...t.Pet.map(p=>({kind:'pet',id:p.id,sourceVersion:p.directory_revision,displayName:p.name,ownerId:p.owner_id,species:p.species,phone:null,breed:p.breed,email:null,microchipId:p.microchip_id,updatedAt:p.updated_at,deletedAt:null}))];
  out.clinic.InboxEvent=[];
  out.notification.Notification=t.Notification.map(r=>convert(r,catalogs.source.Notification,catalogs.notification.Notification));
  const inbox=new Set(t.Notification.map(r=>'legacy-notification:'+r.id)),known=new Map(t.Notification.map(r=>[r.id,r])),evidence=s.evidence.notificationEvents??{};
  const notificationEvents=t.OutboxEvent.map(r=>r.envelope.value).filter(e=>e.eventType==='notification.requested.v1');
  fail(Object.keys(evidence).every(id=>notificationEvents.some(e=>e.eventId===id)),'UNKNOWN_NOTIFICATION_EVIDENCE');
  for(const e of notificationEvents){const n=known.get(e.payload.notificationId),resolution=evidence[e.eventId];
    if(n){for(const field of catalogs.source.Notification.fields.filter(f=>!['id','status','createdAt','sentAt'].includes(f.name)))fail((e.payload[field.name]??null)===(n[field.column]??null),'NOTIFICATION_EVENT_COLLISION');fail(!resolution||resolution==='materialized','NOTIFICATION_EVIDENCE_CONFLICT');inbox.add(e.eventId);}
    else{fail(['pending','deleted'].includes(resolution),'AMBIGUOUS_NOTIFICATION_EVENT_REVIEW_REQUIRED');if(resolution==='deleted')inbox.add(e.eventId);}
  }
  out.notification.InboxEvent=[...inbox].map(eventId=>({consumerName:'notification-v1',eventId,createdAt:at}));
  for(const [component,names]of Object.entries(targets))for(const name of names)out[component][name]=sortRows(catalogs[component][name],out[component][name]);
  return out;
}
export function migrationReport(snapshot,ctx){
  const expected=buildMigration(snapshot,ctx);
  const groups=(rows,column)=>Object.fromEntries([...new Set(rows.map(r=>r[column]))].sort().map(value=>[value,rows.filter(r=>r[column]===value).length]));
  const invoices=snapshot.tables.Invoice,financial=Object.fromEntries([...new Set(invoices.map(i=>i.type+':'+i.payment_status))].sort().map(key=>{const rows=invoices.filter(i=>i.type+':'+i.payment_status===key);return [key,{count:rows.length,totalVnd:rows.reduce((sum,i)=>sum+money(i.total_amount)/100n,0n).toString()}];}));
  return {version:1,run:ctx.run,snapshotHash:snapshot.sha256,source:Object.fromEntries(sourceNames.map(n=>[n,{owner:sourceOwner(n),...reportTable(catalogs.source[n],snapshot.tables[n])}])),target:Object.fromEntries(Object.entries(expected).map(([kind,tables])=>[kind,Object.fromEntries(Object.entries(tables).map(([n,rows])=>[n,reportTable(catalogs[kind][n],rows)]))])),summaries:{appointmentStatus:groups(snapshot.tables.Appointment,'status'),appointmentType:groups(snapshot.tables.Appointment,'type'),hotelStatus:groups(snapshot.tables.HotelBooking,'status'),historyKind:groups(snapshot.tables.BookingStatusEvent,'kind'),notificationReadState:groups(snapshot.tables.Notification,'status'),financial},historicalSnapshotPolicy:'Preserve existing snapshots; reconstruct only when source timestamps/history show no later appointment change, otherwise require review.',notificationPolicy:'Materialized/deleted event IDs seeded in inbox; ambiguous absent notice requires explicit reviewed pending/deleted evidence; pending retained in outbox.'};
}
export async function assertFrozenSource(ctx,snapshot){
  verifySnapshot(snapshot,ctx);return withDatabase(ctx,'legacy',db=>db.$transaction(async tx=>{
    const [gate]=await tx.$queryRaw`SELECT state FROM public.p7_cutover WHERE id=1`;fail(['FROZEN','IMPORTED'].includes(gate.state),'FROZEN_SOURCE_REQUIRED');
    for(const name of sourceNames)fail(digest(await readRows(tx,catalogs.source[name]))===digest(snapshot.tables[name]),'FROZEN_SOURCE_DRIFT');
    const [sequence]=await tx.$queryRaw`SELECT last_value::text,is_called FROM runtime.invoice_transfer_code_seq`;fail(digest(sequence)===digest(snapshot.source.sequence),'FROZEN_SEQUENCE_DRIFT');
  },{isolationLevel:'RepeatableRead',timeout:30000}),{admin:true});
}
// AQ-10: a fresh target already holds the migration's default room capacities; before
// the import that seed counts as empty (the import replaces it with the source rows).
const SEEDED={core:{HotelRoomCapacity:['standard','deluxe','vip']}};
const onlySeed=(kind,name,rows)=>!!SEEDED[kind]?.[name]&&rows.map(r=>r.room_type).sort().join()===[...SEEDED[kind][name]].sort().join();
async function compareComponent(db,kind,expected,{emptyAllowed=false}={}){
  let empty=true,exact=true;const tables={};for(const name of targets[kind]){const actual=await readRows(db,catalogs[kind][name]);empty&&=actual.length===0||onlySeed(kind,name,actual);exact&&=digest(actual)===digest(expected[name]);tables[name]=reportTable(catalogs[kind][name],actual);}
  fail(exact||emptyAllowed&&empty,'TARGET_COLLISION_OR_DRIFT');return {empty,exact,tables};
}
export async function inspectMigration(ctx,snapshot){const expected=buildMigration(snapshot,ctx),report=migrationReport(snapshot,ctx);await assertFrozenSource(ctx,snapshot);report.inspection={};
  for(const kind of ['core','clinic','notification'])report.inspection[kind]=await withDatabase(ctx,kind,db=>compareComponent(db,kind,expected[kind],{emptyAllowed:true}),{admin:true});return report;
}
async function importMigrationLocked(ctx,snapshot,fault){
  const expected=buildMigration(snapshot,ctx);await inspectMigration(ctx,snapshot);
  await withDatabase(ctx,'legacy',async db=>{const [g]=await db.$queryRaw`SELECT state,snapshot_hash FROM public.p7_cutover WHERE id=1`;fail(['FROZEN','IMPORTED'].includes(g.state)&&(!g.snapshot_hash||g.snapshot_hash===snapshot.sha256),'FROZEN_SOURCE_REQUIRED');},{admin:true});
  for(const kind of ['core','clinic','notification'])await withDatabase(ctx,kind,db=>db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(710007)::text`;
    const journals=await tx.$queryRaw`SELECT snapshot_hash FROM public.p7_import_journal`;fail(journals.every(j=>j.snapshot_hash===snapshot.sha256),'IMPORT_SNAPSHOT_REUSE');
    if(journals.length){await compareComponent(tx,kind,expected[kind]);return;}
    // AQ-10: the target migration seeds default room capacities; the source's own rows replace them
    // (rolled back with the transaction if the import fails).
    if(kind==='core')await tx.$executeRawUnsafe('DELETE FROM runtime.hotel_room_capacity');
    const before=await compareComponent(tx,kind,expected[kind],{emptyAllowed:true});fail(before.empty,'TARGET_NOT_EMPTY');
    if(kind==='core'){for(const [table,prefix]of [['users','users'],['pets','pets']])for(const suffix of ['directory_revision','directory_event'])await tx.$executeRawUnsafe(`ALTER TABLE runtime.${ident(table)} DISABLE TRIGGER ${ident(prefix+'_'+suffix)}`);await tx.$executeRawUnsafe('ALTER TABLE runtime.hotel_bookings DISABLE TRIGGER hotel_room_nights_sync');}
    // P10: imported appointments are history: counted in slot usage, never checked for
    // overlap (older data may overlap). The slot tables are recounted once after the rows.
    if(kind==='clinic')await tx.$executeRawUnsafe('ALTER TABLE runtime.appointments DISABLE TRIGGER appointment_schedule_sync');
    for(const name of targets[kind]){await insertRows(tx,catalogs[kind][name],expected[kind][name]);await fault?.(kind,name);}
    if(kind==='clinic'){
      await tx.$executeRawUnsafe('UPDATE runtime.appointments SET schedule_checked=false');
      await tx.$queryRawUnsafe('SELECT runtime.appointment_schedule_rebuild()::text');
      await tx.$executeRawUnsafe('ALTER TABLE runtime.appointments ENABLE TRIGGER appointment_schedule_sync');
    }
    if(kind==='core'){
      for(const [table,prefix]of [['users','users'],['pets','pets']])for(const suffix of ['directory_revision','directory_event'])await tx.$executeRawUnsafe(`ALTER TABLE runtime.${ident(table)} ENABLE TRIGGER ${ident(prefix+'_'+suffix)}`);
      await tx.$executeRawUnsafe('ALTER TABLE runtime.hotel_bookings ENABLE TRIGGER hotel_room_nights_sync');
      const [codes]=await tx.$queryRaw`SELECT COALESCE(max(substring(transfer_code from '^NIPO([0-9]+)$')::bigint),0)::text AS maximum FROM runtime.invoices`;
      const maximum=BigInt(codes.maximum)>BigInt(snapshot.source.sequence.last_value)?codes.maximum:snapshot.source.sequence.last_value;
      await tx.$queryRawUnsafe(`SELECT setval('runtime.invoice_transfer_code_seq', $1::bigint, true)`,maximum);
      await tx.$executeRawUnsafe("ALTER TABLE runtime.booking_status_events ADD CONSTRAINT p7_core_history_owner CHECK(kind='hotel')");
    }
    await compareComponent(tx,kind,expected[kind]);await tx.$executeRaw`INSERT INTO public.p7_import_journal(snapshot_hash) VALUES (${snapshot.sha256})`;
  },{timeout:30000}),{admin:true});
  await withDatabase(ctx,'legacy',db=>db.$executeRaw`UPDATE public.p7_cutover SET state='IMPORTED',snapshot_hash=${snapshot.sha256} WHERE id=1 AND state IN ('FROZEN','IMPORTED')`,{admin:true});
  return validateMigration(ctx,snapshot);
}
export const importMigration=(ctx,snapshot,fault)=>withCutoverLock(ctx,()=>importMigrationLocked(ctx,snapshot,fault));
export async function validateMigration(ctx,snapshot){const expected=buildMigration(snapshot,ctx),report=migrationReport(snapshot,ctx);report.validation={};
  for(const kind of ['core','clinic','notification'])report.validation[kind]=await withDatabase(ctx,kind,async db=>{
    const result=await compareComponent(db,kind,expected[kind]);const fk=await db.$queryRaw`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='runtime' AND c.contype='f'`;
    fail(fk.every(r=>!r.definition.includes('p7_')),'CROSS_SERVICE_FOREIGN_KEY');return {...result,foreignKeys:fk.length};
  },{admin:true});return report;
}
