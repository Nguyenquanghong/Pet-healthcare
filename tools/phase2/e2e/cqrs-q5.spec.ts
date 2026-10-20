import {test,expect} from '@playwright/test';
import {fixture,login,api} from './helpers';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {assertTestProject} from '../test-project.mjs';

test('Q5 100 bookings appear in independent Admin browser through real polling within 10 seconds',async({page,browser})=>{
 test.setTimeout(180000);expect(process.env.CQRS_Q4_E2E).toBe('1');
 const bytes=readFileSync('phase2-plan/cqrs/acceptance.json'),policy=JSON.parse(bytes.toString()),f=fixture();expect((f as any).q4E2e).toBe(true);
 await login(page,'owner');const other=await browser.newContext(),admin=await other.newPage();await login(admin,'admin');await admin.goto('/admin/appointments');
 const name='Q5 '+f.run.slice(0,8);await admin.getByPlaceholder('Tìm theo tên thú cưng, chủ nuôi, sđt, dịch vụ...').fill(name);
 const samples:{index:number;id:string;accepted:number;visibleMs?:number;status:string}[]=[],sources:Record<string,number>={};
 admin.on('response',r=>{if(new URL(r.url()).pathname==='/api/appointments'){const key=r.headers()['x-clinic-read-source']??'missing';sources[key]=(sources[key]??0)+1;}});
 const dir='test-results/phase2/cqrs/q5-admin-'+f.run;mkdirSync(dir,{recursive:true});
 try{
  // <=10 new rows per poll: all remain within page 1 (20 rows), no navigation,
  // synthetic refresh, shared BroadcastChannel, or min-version token at Admin.
  for(let batch=0;batch<10;batch++){
   const pending=[];
   for(let j=0;j<10;j++){
    const index=batch*10+j,label=name+' '+String(index).padStart(3,'0');
    const response=await api(page,'/appointments',{method:'POST',role:'owner',key:randomUUID(),body:{petId:f.pets[0].id,type:'general_checkup',serviceName:label,date:new Date(Date.UTC(2042,0,index+1)).toISOString().slice(0,10),time:'09:00'}});
    expect(response.status).toBe(201);const sample:{index:number;id:string;accepted:number;visibleMs?:number;status:string}={index,id:response.body.appointment.id,accepted:performance.now(),status:'WAITING'};samples.push(sample);
    pending.push((async()=>{await expect(admin.getByText(label,{exact:true})).toBeVisible({timeout:policy.freshness.adminWindowMsMax});sample.visibleMs=performance.now()-sample.accepted;expect(sample.visibleMs).toBeLessThanOrEqual(policy.freshness.adminWindowMsMax);sample.status='PASS';})());
   }
   await Promise.all(pending);console.log('Q5 Admin visible '+samples.length+'/100');
  }
  expect(samples).toHaveLength(policy.freshness.adminWindowCases);expect(sources.projection).toBeGreaterThan(0);
 }finally{writeFileSync(dir+'/samples.json',JSON.stringify({run:f.run,policySha256:createHash('sha256').update(bytes).digest('hex'),samples:samples.map(({accepted,...s})=>s),sources},null,2));console.log(JSON.stringify({q5AdminRun:f.run,samples:samples.length,artifact:dir}));await other.close();}
});

test('Q5 current Core role/deletion revoke old access JWT for projected list and calendar',async({page})=>{
 const f=fixture();await login(page,'admin');const token=await page.evaluate(()=>sessionStorage.getItem('nipopeto_access_token'));
 assertTestProject();const db=new PrismaClient({datasourceUrl:'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test&connection_limit=1'});
 try{
  expect(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`).toEqual([{db:'p2_core_test',role:'p2_core'}]);
  expect(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`).toEqual([{marker:'pet-phase2-p1-test:core:v1'}]);
  const user=await db.user.findUniqueOrThrow({where:{id:f.admin.id}});expect(user.fullName).toBe(f.admin.fullName);expect(user.fullName).toContain(f.run.slice(0,8));expect(user.role).toBe('admin');
  await db.user.update({where:{id:f.admin.id},data:{role:'owner'}});
  try{for(const path of ['/appointments','/appointments/calendar?month=2042-01']){const r=await page.request.get('/api'+path,{headers:{Authorization:'Bearer '+token}});expect([401,403]).toContain(r.status());}}
  finally{await db.user.update({where:{id:f.admin.id},data:{role:'admin'}});}
  // Fresh UUID user belonging to this fixture; deletion tests the real current-account gate.
  await login(page,'other');const deletedToken=await page.evaluate(()=>sessionStorage.getItem('nipopeto_access_token'));
  const target=await db.user.findUniqueOrThrow({where:{id:f.other.id}});expect(target.fullName).toBe(f.other.fullName);expect(target.fullName).toContain(f.run.slice(0,8));await db.user.delete({where:{id:target.id}});
  for(const path of ['/appointments','/appointments/calendar?month=2042-01']){const r=await page.request.get('/api'+path,{headers:{Authorization:'Bearer '+deletedToken}});expect([401,403]).toContain(r.status());}
 }finally{await db.$disconnect();}
});
