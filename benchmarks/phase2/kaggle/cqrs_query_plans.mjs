// Post-load diagnosis on the marked native query-heavy trial only.
// No API budget changes, synthetic query results exposed to users, or writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {guard,validateTarget} from './cqrs_runtime.mjs';

const nodes=new Set(['Aggregate','Group','Hash Join','Merge Join','Nested Loop','Seq Scan','Index Scan','Index Only Scan','Bitmap Heap Scan','Bitmap Index Scan','BitmapAnd','BitmapOr','Sort','Incremental Sort','Hash','Gather','Gather Merge','Materialize','Memoize','Result','Limit','Append','Merge Append','Subquery Scan']);
const joins=new Set(['Inner','Left','Right','Full','Semi','Anti']);
const numbers=['Startup Cost','Total Cost','Plan Rows','Plan Width','Actual Startup Time','Actual Total Time','Actual Rows','Actual Loops','Rows Removed by Filter','Rows Removed by Join Filter','Heap Fetches','Workers Planned','Workers Launched','Shared Hit Blocks','Shared Read Blocks','Shared Dirtied Blocks','Shared Written Blocks','Local Hit Blocks','Local Read Blocks','Temp Read Blocks','Temp Written Blocks','I/O Read Time','I/O Write Time','Hash Buckets','Hash Batches','Peak Memory Usage','Sort Space Used'];
const cases=[['admin-list',{pageSize:'100'}],['admin-search',{q:'Mèo',pageSize:'100'}],['admin-page',{page:'500',pageSize:'100'}],['admin-calendar',{month:'2028-02'}]];
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;

export function sanitizePlan(raw){
  assert.ok(Array.isArray(raw)&&raw.length===1,'PLAN_SHAPE');
  const top=raw[0]?.['QUERY PLAN'];assert.ok(Array.isArray(top)&&top.length===1&&top[0]?.Plan,'PLAN_SHAPE');
  let remaining=64,truncated=false;
  function clean(node,depth=0){
    if(!node||typeof node!=='object'||Array.isArray(node))throw new Error('PLAN_SHAPE');
    if(remaining--<=0||depth>12){truncated=true;return {'Node Type':'Truncated'};}
    const out={'Node Type':nodes.has(node['Node Type'])?node['Node Type']:'Other'};
    if(joins.has(node['Join Type']))out['Join Type']=node['Join Type'];
    for(const key of numbers)if(finite(node[key]))out[key]=node[key];
    if(typeof node['Parallel Aware']==='boolean')out['Parallel Aware']=node['Parallel Aware'];
    // Expressions, filters, aliases, relation/index/schema names, parameters,
    // output columns and per-worker arbitrary objects are deliberately absent.
    if(Array.isArray(node.Plans)){
      out.Plans=[];
      for(const child of node.Plans){
        if(remaining<=0||depth>=12){truncated=true;break;}
        out.Plans.push(clean(child,depth+1));
      }
    }
    return out;
  }
  const result={Plan:clean(top[0].Plan)};
  for(const key of ['Planning Time','Execution Time'])if(finite(top[0][key]))result[key]=top[0][key];
  return {...result,truncated};
}

function safeFailure(error){
  const codes=new Set(['P2010','P2024','P2028','P2021','P2022']);
  const states=new Set(['57014','55P03','53100','53200','53300','42501','42P01','42703']);
  return {status:'UNAVAILABLE',prismaCode:codes.has(error?.code)?error.code:null,sqlState:states.has(error?.meta?.code)?error.meta.code:null};
}

// Execute the real reader only to capture its parameterized counts/calendar
// statement. Suppress that SELECT with an empty result; never return the DTO.
// Directory search still resolves against the same read-only snapshot.
export async function captureStatements(tx,Reader,generation,operation,query){
  const captured=[];
  let proxy;
  proxy=new Proxy({}, {get(_target,key){
    if(key==='$transaction')return work=>work(proxy);
    if(key==='$executeRawUnsafe')return sql=>{
      assert.ok(["SET LOCAL plan_cache_mode='force_custom_plan'",'SET LOCAL max_parallel_workers_per_gather=1','SET LOCAL max_parallel_workers_per_gather=0'].includes(sql));return tx.$executeRawUnsafe(sql);
    };
    if(key==='$queryRaw')return async sql=>{
      assert.ok(typeof sql?.text==='string'&&Array.isArray(sql.values)&&sql.values.length<=1000,'PLAN_QUERY_SHAPE');
      const prefixes=['SELECT p."appointmentDate" AS date,count(*)::int AS n','SELECT p.status,count(*)::int AS n','SELECT p.status,p."appointmentDate" AS date,p.type::text AS type,count(*)::int AS n'];
      assert.ok(prefixes.some(prefix=>sql.text.startsWith(prefix))&&sql.text.includes('JOIN appointments a ON a.id=p."appointmentId"')&&!sql.text.includes(';'),'PLAN_QUERY_SHAPE');
      captured.push(sql);return [];
    };
    if(key==='directoryProjection')return {findMany:args=>tx.directoryProjection.findMany(args)};
    if(key==='appointment')return {findMany:args=>tx.appointment.findMany(args)};
    throw new Error('PLAN_UNEXPECTED_READER_ACCESS');
  }});
  const reader=new Reader(proxy,generation),actor={sub:'diagnostic-admin',role:'admin'};
  if(operation==='admin-calendar')await reader.calendar(actor,query);
  else await reader.list(actor,{lookup:async()=>{throw new Error('PLAN_UNEXPECTED_DIRECTORY');},pet:async()=>{throw new Error('PLAN_UNEXPECTED_DIRECTORY');}},query);
  assert.ok(captured.length>0,'PLAN_QUERY_COUNT');return captured;
}

// Legacy single-statement experiments must fail explicitly if the serving
// reader now splits this aggregate. Never present one fragment as the whole.
export async function captureStatement(...args){
  const captured=await captureStatements(...args);
  assert.equal(captured.length,1,'PLAN_QUERY_COUNT');return captured[0];
}

export async function collectQueryPlans(db,databaseUrl,context,loadReader=async()=>{
  const {ProjectedAppointmentQueries}=await import('../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js');return ProjectedAppointmentQueries;
}){
  // Caller must be the query-heavy native B stack. Reject before touching DB.
  assert.equal(context.kind,'phase2-kaggle-native-v1');assert.equal(context.datasetProfile,'query-heavy');
  assert.equal(context.cqrsConfiguration,'B');assert.equal(context.replicas,1);
  const url=new URL(databaseUrl);url.searchParams.set('connection_limit','1');validateTarget(url,context);
  await guard(db,url,context);
  const Reader=await loadReader(),results=[];
  for(const [operation,query] of cases){
    try{
      const result=await db.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3000ms'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
        const c=await tx.readProjectionControl.findUnique({where:{projectionName:'appointments'},include:{activeGeneration:true}});
        assert.ok(c?.activeGenerationId&&c.servingMode==='projection'&&c.activeGeneration?.state==='ACTIVE'&&c.activeGeneration.verifiedAt&&c.activeGeneration.schemaVersion===1&&c.activeGeneration.projectionName==='appointments','PLAN_GENERATION');
        assert.equal(await tx.appointment.count(),100000,'PLAN_FIXTURE');
        const queries=await captureStatements(tx,Reader,c.activeGenerationId,operation,query),statements=[];
        for(const sql of queries){
          const plan=await tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql.text,...sql.values);
          statements.push({part:statements.length,sqlShapeSha256:createHash('sha256').update(sql.text).digest('hex'),parameterCount:sql.values.length,plan:sanitizePlan(plan)});
        }
        return {operation,status:'COLLECTED',statementCount:statements.length,statements};
      },{isolationLevel:'RepeatableRead',maxWait:250,timeout:6000});
      results.push(result);
    }catch(error){results.push({operation,...safeFailure(error)});}
  }
  return {version:2,status:results.every(r=>r.status==='COLLECTED')?'COLLECTED':'PARTIAL',scope:'post-load-read-only',
    statementTimeoutMs:3000,lockTimeoutMs:250,transactionTimeoutMs:6000,requestsRunning:false,capacityAccepted:false,results};
}
