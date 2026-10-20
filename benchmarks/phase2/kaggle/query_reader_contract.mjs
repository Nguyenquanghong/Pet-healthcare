// Regression oracle: execute the pinned O reader against an in-memory ORM double.
// No database writes or network; output is synthetic API-shaped data only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {appointmentRows} from './query_dataset.mjs';
const sha='3e88d7e57fbf4f74da363d320f286244237a4389';
const git=path=>execFileSync('git',['show',sha+':'+path],{encoding:'utf8'});
const digest=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
for(const name of ['domain/error.ts','domain/validation.ts','lib/serialize.ts']){
  const path='services/clinic/src/'+name;assert.equal(digest(readFileSync(path,'utf8')),digest(git(path)));
}
const source=git('services/clinic/src/lists.ts');
const dir=resolve('test-results/phase2/cqrs','reader-contract-'+randomUUID());mkdirSync(dir,{recursive:true});
const code=stripTypeScriptTypes(source).replace(/from ['"]\.\/([^'"]+)['"]/g,(_,path)=>'from '+JSON.stringify(pathToFileURL(resolve('services/clinic/dist',path)).href));
writeFileSync(resolve(dir,'reader.mjs'),code);
const old=await import(pathToFileURL(resolve(dir,'reader.mjs')).href);
const rows=[],owners=[],pets=[],projections=[];
for(let n=0;n<100;n++){
  const owner={id:'owner-'+n,fullName:'Nguyễn thử '+n,directoryVersion:1};
  const pet={id:'pet-'+n,ownerId:owner.id,name:'Mèo thử '+n,directoryVersion:1};owners.push(owner);pets.push(pet);
  projections.push({kind:'owner',id:owner.id,displayName:owner.fullName,deletedAt:null},
    {kind:'pet',id:pet.id,ownerId:owner.id,displayName:pet.name,deletedAt:null});
  rows.push(...appointmentRows(owner.id,pet.id,n).map((row,i)=>({...row,reservations:i%17===0?[{state:['HELD','INVOICED','RELEASED'][Math.floor(i/17)%3]}]:[]})));
}
function matches(row,where){
  return Object.entries(where??{}).every(([key,c])=>{
    if(key==='AND')return c.every(w=>matches(row,w));if(key==='OR')return c.some(w=>matches(row,w));
    if(key==='reservations')return c.some?row.reservations.some(r=>matches(r,c.some)):!row.reservations.some(r=>matches(r,c.none));
    const v=row[key];if(c instanceof Date)return v?.getTime()===c.getTime();
    if(c&&typeof c==='object'){
      if('in' in c)return c.in.includes(v);if('notIn' in c)return !c.notIn.includes(v);
      if('contains' in c)return typeof v==='string'&&v.toLocaleLowerCase().includes(c.contains.toLocaleLowerCase());
      if('gte' in c||'lt' in c)return (!('gte' in c)||v>=c.gte)&&(!('lt' in c)||v<c.lt);
      throw new Error('Unsupported oracle predicate '+key);
    }return v===c;
  });
}
const statuses=['pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'];
const tx={appointment:{
  groupBy:async q=>{
    const map=new Map(),key=q.by[0];
    for(const row of rows.filter(r=>matches(r,q.where))){const k=row[key] instanceof Date?row[key].toISOString():row[key];map.set(k,(map.get(k)??0)+1);}
    return [...map].map(([v,_count])=>({[key]:key==='appointmentDate'?new Date(v):v,_count}));
  },
  count:async q=>rows.filter(r=>matches(r,q.where)).length,
  findMany:async q=>rows.filter(r=>matches(r,q.where)).sort((a,b)=>{
    for(const order of q.orderBy){const [key,direction]=Object.entries(order)[0];
      const x=key==='status'?statuses.indexOf(a[key]):a[key],y=key==='status'?statuses.indexOf(b[key]):b[key];
      if(x<y)return direction==='asc'?-1:1;if(x>y)return direction==='asc'?1:-1;
    }return 0;
  }).slice(q.skip,q.skip+q.take).map(({reservations,...row})=>row),
},directoryProjection:{findMany:async q=>projections.filter(p=>matches(p,q.where)).map(p=>Object.fromEntries(Object.keys(q.select).map(key=>[key,p[key]])))}};
const db={appointment:tx.appointment,$transaction:async(work,options)=>{assert.equal(options.isolationLevel,'RepeatableRead');return work(tx);}};
const directory={lookup:async(petIds,ownerIds)=>({pets:pets.filter(p=>petIds.includes(p.id)),owners:owners.filter(o=>ownerIds.includes(o.id))})};
const owner={sub:'owner-0',role:'owner'},admin={sub:'admin',role:'admin'},results=[];
for(const [operation,actor,raw] of [
  ['owner-list',owner,{ownerId:'owner-1'}],['admin-list',admin,{pageSize:'100'}],
  ['admin-search',admin,{q:'Mèo',pageSize:'100'}],['admin-unbilled',admin,{mode:'unbilled'}],
  ['admin-filter',admin,{category:'spa',statusGroup:'pending',date:'2028-02-01'}],['admin-page',admin,{page:'500',pageSize:'100'}]]){
  results.push({operation,actor:{id:actor.sub},body:await old.list(db,'appointments',actor,directory,raw)});
}
for(const [operation,actor] of [['owner-calendar',owner],['admin-calendar',admin]])results.push({operation,actor:{id:actor.sub},body:await old.calendar(db,actor,'2028-02')});
const result={baselineSha:sha,readerHash:digest(source),rows:rows.length,results};
writeFileSync(resolve(dir,'responses.json'),JSON.stringify(result));
console.log(JSON.stringify(result));
