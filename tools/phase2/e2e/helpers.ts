import { readFileSync, writeFileSync, promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
export type Fixture = { run: string; password: string; admin:{id:string;username:string;fullName:string}; owner:{id:string;email:string;fullName:string}; other:{id:string;email:string;fullName:string};counter:{id:string;fullName:string}; pets:{id:string;name:string;qrToken:string}[];counterPetId:string;otherPetId:string;origins:Record<string,string> };
export function fixture():Fixture {const f=JSON.parse(readFileSync(resolve('test-results/phase2/p5-e2e-fixture.json'),'utf8'));expect(f.run).toMatch(/^[0-9a-f-]{36}$/);return f;}
export async function controls(values:Record<string,unknown>={}){
  const f=fixture(),file=resolve('test-results/phase2/p5-e2e-controls.json'),tmp=file+'.'+randomUUID();writeFileSync(tmp,JSON.stringify({...values,run:f.run}));
  // Windows may briefly deny replacing a file while the owned server reads it.
  // Preserve atomic replacement; retry this test-only IPC instead of deleting it.
  for(let n=0;;n++){try{await fs.rename(tmp,file);return;}catch(error){if(!['EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||n>=40)throw error;await new Promise(r=>setTimeout(r,25));}}
}
export function observed(){try{const value=JSON.parse(readFileSync('test-results/phase2/p5-e2e-observed.json','utf8'));return value.run===fixture().run?value:{};}catch{return{};}}
export async function freshCore(){const id=randomUUID();await controls({restartCore:id});await expect.poll(()=>observed().coreRestart,{timeout:20000}).toBe(id);}
export async function browserOnlyLocal(page:Page){await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:5189'?route.continue():route.abort());}
export async function login(page:Page,role:'owner'|'admin'|'other'='owner'){
  const f=fixture();await browserOnlyLocal(page);await page.goto(role==='admin'?'/admin/login':'/login');
  if(role==='admin')await page.getByLabel('Username *',{exact:true}).fill(f.admin.username);
  else await page.getByLabel('Email *',{exact:true}).fill(f[role].email);
  await page.getByLabel('Password *',{exact:true}).fill(f.password);
  await page.getByRole('button',{name:role==='admin'?'Sign in as admin':'Sign in',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(role==='admin'?'/admin/dashboard$':'/owner/dashboard$'));
}
const apiTokens=new Map<string,string>();
export async function api(page:Page,path:string,{method='GET',body,role='admin',key}:{method?:string;body?:unknown;role?:'owner'|'admin'|'other';key?:string}={}){
  const f=fixture(),cacheKey=f.run+role;let token=apiTokens.get(cacheKey);
  if(!token){const sign=await page.request.post('/api/auth/'+(role==='admin'?'admin':'owner')+'/login',{data:role==='admin'?{username:f.admin.username,password:f.password}:{email:f[role].email,password:f.password}});expect(sign.status()).toBe(200);token=(await sign.json()).token;apiTokens.set(cacheKey,token!);}
  const r=await page.request.fetch('/api'+path,{method,headers:{Authorization:'Bearer '+token,...(key?{'Idempotency-Key':key}:{})},data:body});
  return{status:r.status(),body:r.status()===204?null:await r.json()};
}
export type NetworkCall = {method:string;path:string;status?:number;failure?:string;outcome:'pending'|'finished'|'failed'};
export function network(page:Page){const calls:NetworkCall[]=[];const byRequest=new Map();
  page.on('request',r=>{const path=new URL(r.url()).pathname;if(!path.startsWith('/api/'))return;const call:NetworkCall={method:r.method(),path,outcome:'pending'};calls.push(call);byRequest.set(r,call);});
  page.on('response',r=>{const call=byRequest.get(r.request());if(call)call.status=r.status();});
  page.on('requestfinished',r=>{const call=byRequest.get(r);if(call)call.outcome='finished';});
  page.on('requestfailed',r=>{const call=byRequest.get(r);if(call){call.outcome='failed';call.failure=r.failure()?.errorText??'Unknown request failure';}});return calls;
}
export async function pickPet(page:Page,index:number,label='Thú cưng'){
  const pet=fixture().pets[index];await page.getByRole('textbox',{name:label+' — tìm kiếm',exact:true}).fill(pet.name);
  await expect(page.getByRole('combobox',{name:label,exact:true}).locator('option',{hasText:pet.name})).toHaveCount(1);
  await page.getByRole('combobox',{name:label,exact:true}).selectOption(pet.id);return pet;
}
export async function appointment(page:Page,index:number,type='spa_bath',date='2040-01-02',time='10:00'){
  const r=await api(page,'/appointments',{method:'POST',role:'owner',key:randomUUID(),body:{petId:fixture().pets[index].id,type,serviceName:'P5 '+randomUUID().slice(0,8),date,time}});expect(r.status).toBe(201);return r.body.appointment;
}
export async function transition(page:Page,source:any,status:string,collection='appointments'){
  const r=await api(page,`/${collection}/${source.id}/status`,{method:'PATCH',body:{status,expectedRevision:source.statusRevision}});expect(r.status).toBe(200);return r.body.appointment??r.body.booking;
}
export async function completedSpa(page:Page,index:number){let a=await appointment(page,index);for(const s of ['confirmed','checked_in','in_progress','completed'])a=await transition(page,a,s);return a;}
