import {test,expect,type Page} from '@playwright/test';
import {fixture,login,api,controls,observed,appointment,transition} from './helpers';

// D4 real stack: built frontend -> local gateway proxy -> Core proxy -> Clinic API
// (CLINIC_ACTIVITY_MODE=control + evidence sampler) -> PostgreSQL; outbox relay,
// RabbitMQ and the built V2 read worker maintain row+summary. Operator control is
// changed in the isolated schema through the harness IPC, never by the browser.
const range={from:'2040-05-01',to:'2040-05-31'},query=`from=${range.from}&to=${range.to}`;
const section=(page:Page)=>page.getByRole('region',{name:'Hoạt động khám và Spa'});
// Re-applying identical filters keeps the same query key (no duplicate request), so
// each check starts from a fresh dashboard view.
async function show(page:Page){
  await page.goto('/admin/dashboard');const s=section(page);await s.getByLabel('Hoạt động từ ngày',{exact:true}).fill(range.from);await s.getByLabel('Hoạt động đến ngày',{exact:true}).fill(range.to);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/dashboard/clinic/activity'&&new URL(r.url()).searchParams.get('from')===range.from);
  await s.getByRole('button',{name:'Xem thống kê',exact:true}).click();const r=await response;
  return {status:r.status(),headers:r.headers(),body:await r.json()};
}
const state=async(page:Page)=>{const r=await api(page,'/dashboard/clinic/activity?'+query);expect(r.status).toBe(200);return r.body;};

test('D4 real stack: source -> summary via operator control, catch-up through worker, rollback, drilldown, roles, logout/login',async({page})=>{
  test.setTimeout(180000);
  const f=fixture();expect((f as any).activityE2e).toBe(true);
  await login(page,'admin');
  let r=await show(page);expect(r.status).toBe(200);expect(r.body.meta.source).toBe('source');expect(r.body.current.total).toBe(0);
  expect(r.headers['cache-control']).toBe('no-store');
  const a=await appointment(page,0,'general_checkup','2040-05-10','09:00');await appointment(page,1,'spa_bath','2040-05-10','10:00');await appointment(page,2,'vaccination','2040-05-11','11:00');
  await controls({activityMode:'summary'});await expect.poll(()=>observed().activityMode).toBe('summary');
  // Background evidence (row audit 2s, summary audit 30s) + worker catch-up decide eligibility.
  await expect.poll(async()=>{const b=await state(page);return `${b.meta.source}:${b.current.total}`;},{timeout:60000,intervals:[500,1000,2000]}).toBe('summary:3');
  r=await show(page);expect(r.body.meta.source).toBe('summary');expect(r.headers['x-clinic-read-source']).toBe('summary');expect(r.headers['x-clinic-projection-generation']).toBe(r.body.meta.generation);
  await expect(section(page).getByText('Tổng lịch',{exact:true}).locator('..')).toContainText('3');
  await expect(section(page).getByText('Số liệu tổng hợp đang cập nhật.',{exact:true})).toBeVisible();
  await expect(section(page).getByText(r.body.meta.generation)).toHaveCount(0);
  // A transfer is applied by the worker exactly once; summary stays equal to source.
  await transition(page,a,'cancelled');
  await expect.poll(async()=>{const b=await state(page);return `${b.meta.source}:${b.current.byStatus.cancelled}:${b.current.total}`;},{timeout:30000,intervals:[500,1000]}).toBe('summary:1:3');
  await controls({activityMode:'source'});await expect.poll(()=>observed().activityMode).toBe('source');
  await expect.poll(async()=>(await state(page)).meta.source,{timeout:10000}).toBe('source');
  const source=await state(page);await controls({activityMode:'summary'});
  await expect.poll(async()=>(await state(page)).meta.source,{timeout:60000,intervals:[500,1000,2000]}).toBe('summary');
  const summary=await state(page);const {meta:_s,...sb}=source,{meta:_p,...pb}=summary;expect(pb).toEqual(sb);
  // Daily drilldown opens the authoritative list with the same date/category/status.
  r=await show(page);const list=page.waitForResponse(x=>new URL(x.url()).pathname==='/api/appointments'&&x.request().method()==='GET');
  await section(page).getByRole('button',{name:'Xem cancelled ngày 2040-05-10',exact:true}).click();await expect(page).toHaveURL(/date=2040-05-10/);
  const listed=await list;expect(listed.request().headers()['x-clinic-read-consistency']).toBe('authoritative');expect((await listed.json()).items.some((x:any)=>x.id===a.id)).toBe(true);
  expect(new URL(listed.url()).searchParams.get('status')).toBe('cancelled');
  // Owners never see or reach activity, even while summary is eligible.
  expect((await api(page,'/dashboard/clinic/activity?'+query,{role:'owner'})).status).toBe(403);
  await page.goto('/admin/dashboard');await expect(section(page)).toBeVisible();
  await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
  const after:string[]=[];page.on('request',x=>{if(new URL(x.url()).pathname==='/api/dashboard/clinic/activity')after.push(x.url());});
  await page.waitForTimeout(16000);expect(after).toHaveLength(0);
  await login(page,'admin');r=await show(page);expect(r.status).toBe(200);expect(['summary','source']).toContain(r.body.meta.source);expect(r.body.current.total).toBe(3);
  await controls({activityMode:'source'});await expect.poll(()=>observed().activityMode).toBe('source');
});
