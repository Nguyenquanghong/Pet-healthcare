// In-memory stand-in for the projector's Prisma transaction surface. Unit tests
// use it to check algorithm/ordering/rollback logic only: it is NOT evidence of
// PostgreSQL atomicity, locking or isolation (see summary.integration.mjs).
import {randomUUID} from 'node:crypto';

export const bucketId=(g,date,type,status)=>[g,date,type,status].join('|');
export function summaryModel(){
  let state={revisions:new Map(),sources:new Map(),generations:[],control:true,rows:new Map(),inbox:new Set(),summary:new Map()};
  const ops=[];
  const sql=strings=>strings.join('?').replace(/\s+/g,' ');
  const rowKey=(g,id)=>g+'|'+id;
  const tx={
    async $queryRaw(strings,...v){
      const q=sql(strings);ops.push({op:'query',q});
      if(q.includes('FROM "ClinicReadRevision"')){const r=state.revisions.get(v[0]);return r?[{...r}]:[];}
      if(q.includes('FROM "ReadProjectionControl"'))return state.control?[{projectionName:'appointments'}]:[];
      if(q.includes('FROM "AppointmentDailySummary"'))return [{n:state.summary.has(bucketId(...v))?1:0}];
      throw new Error('MODEL_UNKNOWN_QUERY '+q);
    },
    async $executeRaw(strings,...v){
      const q=sql(strings);
      if(q.startsWith('INSERT INTO "InboxEvent"')){const k=v[0]+'|'+v[1];ops.push({op:'inbox',ns:v[0]});if(state.inbox.has(k))return 0;state.inbox.add(k);return 1;}
      if(q.startsWith('UPDATE "AppointmentDailySummary"')){
        const [n,...key]=v,id=bucketId(...key);ops.push({op:'decrement',id});
        const old=state.summary.get(id);if(old===undefined||old<n)return 0;state.summary.set(id,old-n);return 1;}
      if(q.startsWith('INSERT INTO "AppointmentDailySummary"')){
        const n=v[4],id=bucketId(...v.slice(0,4));ops.push({op:'increment',id});
        if(!state.generations.some(g=>g.id===v[0]&&g.schemaVersion===2))throw new Error('MODEL_FK_V2_ONLY');
        state.summary.set(id,(state.summary.get(id)??0n)+n);return 1;}
      throw new Error('MODEL_UNKNOWN_STATEMENT '+q);
    },
    readProjectionGeneration:{findMany:async({where,take})=>state.generations.filter(g=>g.projectionName===where.projectionName&&where.state.in.includes(g.state)).sort((a,b)=>a.id<b.id?-1:1).slice(0,take).map(g=>({id:g.id,schemaVersion:g.schemaVersion}))},
    appointment:{findUnique:async({where})=>{const s=state.sources.get(where.id);return s?structuredClone(s):null;}},
    appointmentReadRow:{
      findUnique:async({where})=>{const k=where.generation_appointmentId,r=state.rows.get(rowKey(k.generation,k.appointmentId));return r?structuredClone(r):null;},
      deleteMany:async({where})=>{ops.push({op:'row-delete',generation:where.generation});state.rows.delete(rowKey(where.generation,where.appointmentId));return {count:1};},
      upsert:async({where,create,update})=>{const k=where.generation_appointmentId,key=rowKey(k.generation,k.appointmentId);ops.push({op:'row-upsert',generation:k.generation});
        state.rows.set(key,state.rows.has(key)?{...state.rows.get(key),...update}:{...create});return state.rows.get(key);},
    },
  };
  const db={async $transaction(work){const saved=structuredClone(state);try{return await work(tx);}catch(error){state=saved;ops.push({op:'rollback'});throw error;}}};
  const api={db,ops,get state(){return state;},
    generation(schemaVersion,state='ACTIVE',id=randomUUID()){api.state.generations.push({id,schemaVersion,state,projectionName:'appointments'});return id;},
    // Source writer: change appointment then bump the independent read revision.
    write(id,patch={},{deleted=false}={}){
      const r=api.state.revisions.get(id);
      if(deleted)api.state.sources.delete(id);
      else api.state.sources.set(id,{id,petId:'pet',ownerId:'owner',doctorId:null,type:'general_checkup',serviceName:'Fixture',clinicName:'Fixture',appointmentDate:new Date('2030-10-20T00:00:00Z'),appointmentTime:'09:00',status:'pending',statusRevision:0,ownerNote:null,internalNote:null,createdBy:'owner',createdAt:new Date('2030-10-01T00:00:00Z'),updatedAt:new Date(),reservations:[],...api.state.sources.get(id),...patch});
      const version=(r?.version??0)+1;api.state.revisions.set(id,{version,deleted});
      return event(id,version,deleted);
    },
    count:(g,date,type,status)=>api.state.summary.get(bucketId(g,date,type,status)),
    // Canonical rows->summary GROUP BY for the generation, zero buckets normalized.
    reconcile(g){
      const expected=new Map();
      for(const [k,r] of api.state.rows)if(k.startsWith(g+'|')&&!r.deletedAt){const id=bucketId(g,r.appointmentDate.toISOString().slice(0,10),r.type,r.status);expected.set(id,(expected.get(id)??0n)+1n);}
      const actual=new Map([...api.state.summary].filter(([k,n])=>k.startsWith(g+'|')&&n!==0n));
      const keys=new Set([...expected.keys(),...actual.keys()]);
      return [...keys].filter(k=>expected.get(k)!==actual.get(k)).length;
    },
  };
  return api;
}
export function event(id,version,deleted=false,eventId=randomUUID()){
  return JSON.stringify({eventId,eventType:'clinic.appointment-read-changed.v1',schemaVersion:1,producer:'clinic',aggregateType:'appointment',aggregateId:id,aggregateVersion:version,occurredAt:new Date().toISOString(),correlationId:eventId,payload:{appointmentId:id,sourceVersion:version,deleted}});
}
