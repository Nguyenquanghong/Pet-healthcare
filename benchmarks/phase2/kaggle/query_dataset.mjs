// Called only after native stack verifies fresh UUID PG directory, roles and markers.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

export function appointmentRows(ownerId,petId,ownerIndex){
  const statuses=['pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'];
  const types=['general_checkup','vaccination','dental','dermatology','surgery','hotel_consultation','spa_bath','spa_grooming','spa_combo','other'];
  return Array.from({length:1000},(_,i)=>({id:randomUUID(),ownerId,petId,type:types[i%10],status:statuses[i%7],
    serviceName:'Khám có dấu '+i%13,clinicName:'Synthetic query clinic',
    appointmentDate:new Date(Date.UTC(2028,1,1+Math.floor(i/48))),
    appointmentTime:String(Math.floor(i%48/2)).padStart(2,'0')+(i%2?':30':':00'),
    statusRevision:0,ownerNote:'Synthetic note',internalNote:'QUERY_PRIVATE',createdBy:'owner',
    createdAt:new Date(Date.UTC(2027,0,1)+(ownerIndex*1000+i)*1000),updatedAt:new Date(Date.UTC(2027,0,1))}));
}

export async function createQueryDataset(db,{run,hash,count}){
  assert.equal(count,100,'Query-heavy requires exactly 100 owners');
  const accounts=[];let reservations=0;
  for(let n=0;n<count;n++){
    const owner=await db.core.user.create({data:{id:randomUUID(),email:`query-${run}-${n}@example.test`,fullName:`Nguyễn thử ${n}`,role:'owner',...hash}});
    const pet=await db.core.pet.create({data:{id:randomUUID(),ownerId:owner.id,name:`Mèo thử ${n}`,species:'cat',allergies:[]}});
    const rows=appointmentRows(owner.id,pet.id,n);
    for(let start=0;start<rows.length;start+=500)await db.clinic.appointment.createMany({data:rows.slice(start,start+500)});
    const held=rows.filter((_,i)=>i%17===0).map((row,i)=>({operationId:randomUUID(),appointmentId:row.id,revisionAtPrepare:0,snapshot:{},state:['HELD','INVOICED','RELEASED'][i%3]}));
    await db.clinic.appointmentReservation.createMany({data:held});reservations+=held.length;
    await db.clinic.medicalRecord.create({data:{id:randomUUID(),ownerId:owner.id,petId:pet.id,appointmentId:rows[4].id,
      doctorName:'Synthetic doctor',visitDate:rows[4].appointmentDate,title:'Synthetic query record',diagnosis:'Fixture only',treatment:'Fixture only',internalNote:'QUERY_PRIVATE'}});
    await db.clinic.directoryProjection.createMany({data:[
      {kind:'owner',id:owner.id,displayName:owner.fullName,sourceVersion:owner.directoryRevision},
      {kind:'pet',id:pet.id,ownerId:owner.id,displayName:pet.name,species:'cat',sourceVersion:pet.directoryRevision}]});
    accounts.push({id:owner.id,email:owner.email,pets:[{id:pet.id,name:pet.name}]});
  }
  await db.clinic.$executeRawUnsafe('ANALYZE appointments');
  await db.clinic.$executeRawUnsafe('ANALYZE "AppointmentReservation"');
  await db.clinic.$executeRawUnsafe('ANALYZE "DirectoryProjection"');
  assert.equal(await db.clinic.appointment.count(),100000);
  return {accounts,description:{version:'cqrs-query-heavy-v1',synthetic:true,accounts:100,pets:100,
    appointments:100000,reservations,medicalRecords:100,month:'2028-02',
    distribution:'1000 appointments/owner; 7 statuses, 10 types, 21 dates; UUID IDs; fixed dates/order keys; no measured writes'}};
}

export async function querySnapshot(db){
  const result={};
  for(const [model,key] of [['appointment','id'],['appointmentReservation','operationId'],['medicalRecord','id']]){
    const digest=createHash('sha256');let count=0,cursor;
    for(;;){
      const rows=await db[model].findMany({orderBy:{[key]:'asc'},take:1000,...(cursor?{cursor:{[key]:cursor},skip:1}:{})});
      for(const row of rows)digest.update(JSON.stringify(row)+'\n');
      count+=rows.length;if(rows.length<1000)break;cursor=rows.at(-1)[key];
    }
    result[model]={count,sha256:digest.digest('hex')};
  }
  return result;
}

export async function queryObserve(db){
  const [activity]=await db.$queryRaw`SELECT count(*)::int AS sessions,
    count(*) FILTER(WHERE state='active')::int AS active,
    count(*) FILTER(WHERE wait_event_type='Lock')::int AS lock_waiters,
    (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted) AS ungranted_locks
    FROM pg_stat_activity WHERE datname=current_database()`;
  const tables=await db.$queryRaw`SELECT relname,seq_scan::text,seq_tup_read::text,idx_scan::text,
    pg_total_relation_size(relid)::text AS total_bytes FROM pg_stat_user_tables ORDER BY relname`;
  const io=await db.$queryRaw`SELECT relname,heap_blks_read::text,heap_blks_hit::text,idx_blks_read::text,idx_blks_hit::text
    FROM pg_statio_user_tables ORDER BY relname`;
  return {activity,tables,io};
}
