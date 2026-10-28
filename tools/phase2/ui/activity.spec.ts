import {test,expect,type BrowserContext} from '@playwright/test';
import {parseActivityFilter,buildActivityBusiness} from '../../../services/clinic/dist/application/queries/clinicActivity.js';

async function fixture(context:BrowserContext, role='admin') {
  const state={meta:undefined as unknown,fail:false,denied:false,zero:false,hold:false,releases:[] as (()=>void)[],activity:[] as string[],lists:[] as {url:URL;headers:Record<string,string>}[]};
  await context.addInitScript(()=>sessionStorage.setItem('nipopeto_access_token','activity-ui-admin'));
  await context.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    const json=(body:unknown,status=200)=>route.fulfill({status,json:body,headers:{'access-control-allow-origin':'*'}}).catch(()=>{});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}});
    if(path==='/api/auth/me')return json({user:{id:'activity-ui-admin',role,fullName:'Activity admin'}});
    if(path==='/api/notifications/unread-count')return json({unread:0});
    if(path==='/api/dashboard/core')return json({pets:[],owners:[],hotelBookings:[],summary:{totals:{},species:{},hotelStatus:{}}});
    if(path==='/api/dashboard/clinic')return json({pets:[],owners:[],appointments:[],medicalRecords:[],summary:{totals:{},appointmentStatus:{},todayAppointments:0}});
    if(path==='/api/dashboard/clinic/activity'){
      state.activity.push(url.search);
      if(state.hold)await new Promise<void>(r=>state.releases.push(r));
      if(state.denied)return json({error:'Admin activity access revoked'},403);
      if(state.fail)return json({error:'Activity fixture unavailable'},503);
      const filter=parseActivityFilter(Object.fromEntries(url.searchParams)),n=filter.category==='spa'?3:7;
      const rows=state.zero?[]:[{date:filter.to,type:filter.category==='spa'?'spa_bath':'general_checkup',status:'cancelled',n:2n},{date:filter.to,type:filter.category==='spa'?'spa_bath':'general_checkup',status:'completed',n:BigInt(n-2)}];
      return json({...buildActivityBusiness(filter,rows as any),meta:state.meta??{source:'source',generatedAt:new Date().toISOString(),degraded:false,reason:null,freshness:{state:'current'}}});
    }
    if(path==='/api/appointments')state.lists.push({url,headers:req.headers()});
    return json({items:[],pagination:{page:1,pageSize:20,total:0,totalPages:0},counts:{},related:{pets:[],owners:[],appointments:[],medicalRecords:[],hotelBookings:[]}});
  });
  return state;
}
test('activity shows loading/error/zero separately and drills into exact daily authoritative filters',async({page,context})=>{
  const state=await fixture(context);state.fail=true;await page.goto('/admin');
  const section=page.getByRole('region',{name:'Hoạt động khám và Spa'});await expect(section.getByRole('alert')).toContainText('Chưa cập nhật được');
  await expect(section.getByText('Tổng lịch',{exact:true})).toHaveCount(0);
  state.fail=false;state.zero=true;await section.getByRole('button',{name:'Thử lại hoạt động khám và Spa'}).click();
  await expect(section.getByText('Tổng lịch',{exact:true}).locator('..')).toContainText('0');
  await expect(section.getByText('Tỷ lệ hủy',{exact:true}).locator('..')).toContainText('—');
  state.zero=false;
  await section.getByLabel('Hoạt động từ ngày',{exact:true}).fill('2030-10-01');
  await section.getByLabel('Hoạt động đến ngày',{exact:true}).fill('2030-10-20');
  await section.getByLabel('Nhóm dịch vụ hoạt động',{exact:true}).selectOption('clinic');
  await section.getByRole('button',{name:'Xem thống kê',exact:true}).click();
  await expect(section.getByText('Tổng lịch',{exact:true}).locator('..')).toContainText('7');
  await page.screenshot({path:'test-results/phase2/cqrs/activity/d1-ui-dashboard.png',fullPage:true});
  await section.getByRole('button',{name:'Xem cancelled ngày 2030-10-20',exact:true}).click();
  await expect(page).toHaveURL(/date=2030-10-20/);
  await expect.poll(()=>state.lists.length).toBeGreaterThan(0);
  const list=state.lists.at(-1)!;
  expect(list.url.searchParams.get('date')).toBe('2030-10-20');expect(list.url.searchParams.get('category')).toBe('medical');expect(list.url.searchParams.get('status')).toBe('cancelled');
});
test('late filter responses never replace the newer query; hidden polling stops and logout clears activity',async({page,context})=>{
  const state=await fixture(context);state.hold=true;
  await page.clock.install();await page.goto('/admin');const section=page.getByRole('region',{name:'Hoạt động khám và Spa'});
  await expect(section.getByRole('status')).toContainText('Đang tải');await expect.poll(()=>state.releases.length).toBe(1);
  const old=state.releases[0];state.hold=false;
  await section.getByLabel('Nhóm dịch vụ hoạt động',{exact:true}).selectOption('spa');await section.getByRole('button',{name:'Xem thống kê',exact:true}).click();
  const total=section.getByText('Tổng lịch',{exact:true}).locator('..');await expect(total).toContainText('3');old();await expect(total).toContainText('3');
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  const hidden=state.activity.length;await page.clock.fastForward(35000);expect(state.activity.length).toBe(hidden);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>state.activity.length).toBeGreaterThan(hidden);
  await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();await expect(section).toHaveCount(0);
  const loggedOut=state.activity.length;await page.clock.fastForward(35000);expect(state.activity.length).toBe(loggedOut);
});
test('activity polls independently at 15s, coalesces a pending poll and is hidden for non-admin roles',async({page,context,browser})=>{
  const state=await fixture(context);await page.clock.install();await page.goto('/admin');
  const section=page.getByRole('region',{name:'Hoạt động khám và Spa'});await expect(section.getByText('Tổng lịch',{exact:true})).toBeVisible();
  expect(state.activity).toHaveLength(1);await page.clock.fastForward(6000);expect(state.activity).toHaveLength(1);
  state.hold=true;await page.clock.fastForward(20000);await expect.poll(()=>state.releases.length).toBe(1);
  const pending=state.activity.length;await page.clock.fastForward(35000);expect(state.activity.length).toBe(pending);
  state.hold=false;state.releases[0]();
  const other=await browser.newContext();try{const staff=await fixture(other,'staff'),tab=await other.newPage();await tab.goto('/admin');await expect(tab.getByRole('region',{name:'Hoạt động khám và Spa'})).toHaveCount(0);expect(staff.activity).toHaveLength(0);}finally{await other.close();}
});
test('monthly counts have no whole-period list link; choose an explicit day for drilldown',async({page,context})=>{
  const state=await fixture(context);await page.goto('/admin');const section=page.getByRole('region',{name:'Hoạt động khám và Spa'});
  await section.getByLabel('Hoạt động từ ngày',{exact:true}).fill('2030-09-21');await section.getByLabel('Hoạt động đến ngày',{exact:true}).fill('2030-10-20');
  await section.getByLabel('Nhóm thời gian hoạt động',{exact:true}).selectOption('month');await section.getByRole('button',{name:'Xem thống kê',exact:true}).click();
  await expect(section.getByRole('table').getByRole('button')).toHaveCount(0);
  await section.getByLabel('Ngày xem lịch từ hoạt động',{exact:true}).fill('2030-10-13');await section.getByRole('button',{name:'Xem lịch ngày đã chọn',exact:true}).click();
  await expect(page).toHaveURL(/date=2030-10-13/);await expect.poll(()=>state.lists.length).toBeGreaterThan(0);
});
test('a revoked activity role clears previously displayed aggregates on the next forbidden response',async({page,context})=>{
  const state=await fixture(context);await page.clock.install();await page.goto('/admin');
  const section=page.getByRole('region',{name:'Hoạt động khám và Spa'});
  await expect(section.getByText('Tổng lịch',{exact:true}).locator('..')).toContainText('7');
  state.denied=true;await page.clock.fastForward(20000);
  await expect(section.getByRole('alert')).toContainText('Chưa cập nhật được hoạt động khám và Spa');
  await expect(section.getByText('Tổng lịch',{exact:true})).toHaveCount(0);
});
test('cached metadata shows the updating note with the same totals; a fresh source snapshot does not',async({page,context})=>{
  const state=await fixture(context);await page.clock.install();await page.goto('/admin');
  const section=page.getByRole('region',{name:'Hoạt động khám và Spa'}),note=section.getByText('Số liệu tổng hợp đang cập nhật.',{exact:true});
  const total=section.getByText('Tổng lịch',{exact:true}).locator('..');
  await expect(total).toContainText('7');await expect(note).toHaveCount(0);
  state.meta={source:'cached',generatedAt:new Date().toISOString(),cacheComputedAt:new Date().toISOString(),degraded:false,reason:null,freshness:{state:'within-policy',checkedAt:new Date().toISOString(),observedLagMs:2000}};
  await page.clock.fastForward(20000);await expect(note).toBeVisible();await expect(total).toContainText('7');
  state.meta=undefined;await page.clock.fastForward(20000);await expect(note).toHaveCount(0);
});
