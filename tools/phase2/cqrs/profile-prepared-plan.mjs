import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {assertTestProject} from '../test-project.mjs';
const args=process.argv.slice(2);assert.equal(args.length,2);
for(const path of args)assert.ok(resolve(path).startsWith(resolve('test-results/phase2/cqrs')+sep));
const c=JSON.parse(readFileSync(args[0],'utf8')),profile=JSON.parse(readFileSync(args[1],'utf8'));assert.equal(c.schema,profile.schema);
assertTestProject();const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','1');
const db=new PrismaClient({datasourceUrl:url.href});const results=[];
const out=resolve('test-results/phase2/cqrs/prepared-plan-'+randomUUID());mkdirSync(out);
try{
 await guard(db,url,c);
 for(const [name,sql,values] of [
  ['admin-calendar',profile.plans.find(p=>p.sql.startsWith('SELECT p."appointmentDate"')&&!p.sql.includes('a.owner_id=$')).sql,[c.generation,'2028-02-01','2028-03-01']],
  ['admin-counts',profile.plans.find(p=>p.sql.startsWith('SELECT p.status')&&!p.sql.includes('a.owner_id=$')&&!p.sql.includes('ILIKE')).sql,[c.generation]]
 ])for(const mode of ['force_custom_plan','force_generic_plan'])for(const acl of ['equality','boolean-check']){
  const statement=acl==='equality'?sql:sql.replace('a.owner_id=p."ownerId" AND a.pet_id=p."petId"','CASE WHEN a.owner_id=p."ownerId" AND a.pet_id=p."petId" THEN TRUE ELSE FALSE END');
  const result=await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
   await tx.$executeRawUnsafe('SET LOCAL plan_cache_mode='+mode);
   await tx.$executeRawUnsafe('PREPARE q6_diagnostic AS '+statement);
   try{return await tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE q6_diagnostic('+values.map(s=>"'"+s.replaceAll("'","''")+"'").join(',')+')');}
   finally{await tx.$executeRawUnsafe('DEALLOCATE q6_diagnostic');}
  },{timeout:35000});
  results.push({name,mode,acl,plan:result});console.log(JSON.stringify({name,mode,acl,ms:result[0]['QUERY PLAN'][0]['Execution Time']}));
 }
}finally{await db.$disconnect();writeFileSync(resolve(out,'report.json'),JSON.stringify({schema:c.schema,scope:'read-only prepared-plan diagnosis on marked trial',results},null,2));console.log(out);}
