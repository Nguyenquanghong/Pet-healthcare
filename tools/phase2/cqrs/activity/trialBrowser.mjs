import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,extname} from 'node:path';
import {once} from 'node:events';
import {chromium,expect} from '@playwright/test';

// Nginx proxies the public UI path here. Keep its unprivileged workers away
// from the mode0700 private trial directory and credentials.
export async function startTrialFrontend(directory){
  const root=realpathSync(directory),index=resolve(root,'index.html');assert.ok(statSync(index).isFile());
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
  const server=createServer((req,res)=>{
    try{
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
      const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
      if(path.startsWith('/api/')){res.writeHead(503);res.end();return;}
      let file=resolve(root,'.'+path);
      if(relative(root,file).startsWith('..')){res.writeHead(404);res.end();return;}
      try{if(!statSync(file).isFile())file=index;}catch{file=index;}
      if(relative(root,realpathSync(file)).startsWith('..')){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream','cache-control':'no-store'});
      res.end(req.method==='HEAD'?undefined:readFileSync(file));
    }catch{res.writeHead(400);res.end();}
  }).listen(0,'127.0.0.1');await once(server,'listening');
  return server;
}

export async function verifyGatewayBrowser({gateway,mode,login,expected,expectedRows,setRole}){
  const origin=new URL(gateway).origin;assert.equal(new URL(gateway).hostname,'127.0.0.1');
  const browser=await chromium.launch({headless:true});
  let context;
  try{
    context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
    let apiRequests=0,activityRequests=0;const rejected=[],pageErrors=[],cases=[];
    // Network scope guard only: no response fulfillment, DB/directory doubles,
    // supplied JWT or sessionStorage injection. Login goes through the real UI.
    await context.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.origin!==origin){rejected.push('OUTSIDE_GATEWAY');return route.abort();}
      if(u.pathname.startsWith('/api/')){
        if(++apiRequests>160){rejected.push('BROWSER_REQUEST_BUDGET');return route.abort();}
        if(u.pathname==='/api/dashboard/clinic/activity')activityRequests++;
        if(route.request().method()!=='GET'&&u.pathname!=='/api/auth/admin/login'){
          rejected.push('UNEXPECTED_BROWSER_COMMAND');return route.abort();
        }
      }
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>pageErrors.push('PAGE_ERROR'));
    await page.clock.install();
    const navigation=await page.goto(gateway+'/admin/login');assert.equal(navigation.status(),200);
    await page.getByLabel('Username *',{exact:true}).fill(login.username);
    await page.getByLabel('Password *',{exact:true}).fill(login.password);
    const signedIn=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/admin/login');
    await page.getByRole('button',{name:'Sign in as admin',exact:true}).click();assert.equal((await signedIn).status(),200);
    const section=page.getByRole('region',{name:'Hoạt động khám và Spa'});
    await expect(section).toBeVisible();
    const me=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/me');
    await page.reload();assert.equal((await me).status(),200);await expect(section).toBeVisible();
    cases.push({operation:'real-login-and-session-reload',status:'PASS'});
    const raw={from:'2030-10-20',to:'2030-10-20',category:'clinic',groupBy:'day'};
    const matches=r=>{const u=new URL(r.url());return u.pathname==='/api/dashboard/clinic/activity'&&Object.entries(raw).every(([k,v])=>u.searchParams.get(k)===v);};
    const apply=async()=>{
      await section.getByLabel('Hoạt động từ ngày',{exact:true}).fill(raw.from);
      await section.getByLabel('Hoạt động đến ngày',{exact:true}).fill(raw.to);
      await section.getByLabel('Nhóm dịch vụ hoạt động',{exact:true}).selectOption(raw.category);
      const response=page.waitForResponse(matches);
      await section.getByRole('button',{name:'Xem thống kê',exact:true}).click();
      const r=await response;assert.equal(r.status(),200);const {meta,...business}=await r.json();assert.deepEqual(business,expected(raw));
      assert.equal(r.headers()['x-clinic-read-source'],meta.source);assert.equal(r.headers()['cache-control'],'no-store');
      await expect(section.getByText('Tổng lịch',{exact:true}).locator('..').locator('p').nth(1)).toHaveText(business.current.total.toLocaleString('vi-VN'));
    };
    await apply();cases.push({operation:'render-real-activity-and-filter-parity',status:'PASS'});
    const list=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/appointments'&&u.searchParams.get('date')===raw.to&&u.searchParams.get('category')==='medical'&&u.searchParams.get('status')==='cancelled';});
    await section.getByRole('button',{name:'Xem cancelled ngày 2030-10-20',exact:true}).click();
    await expect(page).toHaveURL(/\/admin\/appointments\?/);
    const response=await list;assert.equal(response.status(),200);assert.equal(response.headers()['x-clinic-read-source'],'authoritative');
    assert.equal(response.request().headers()['x-clinic-read-consistency'],'authoritative');
    const body=await response.json();assert.equal(body.pagination.total,expectedRows.length);
    assert.deepEqual(body.items.map(x=>x.id).sort(),expectedRows.slice().sort());
    await expect(page.getByRole('heading',{name:'Quản lý lịch hẹn',exact:true})).toBeVisible();
    cases.push({operation:'ui-daily-clinic-medical-authoritative-drilldown',status:'PASS'});
    await page.goto(gateway+'/admin');await expect(section).toBeVisible();await apply();
    try{
      await setRole('staff');const forbidden=page.waitForResponse(matches);
      await page.clock.fastForward(20000);assert.equal((await forbidden).status(),403);
      await expect(section.getByText('Tổng lịch',{exact:true})).toHaveCount(0);
      await expect(section.getByRole('alert')).toContainText('Chưa cập nhật được');
    }finally{await setRole('admin');}
    cases.push({operation:'real-role-revocation-clears-browser-aggregate',status:'PASS'});
    await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();
    await expect(section).toHaveCount(0);await expect(page).toHaveURL(/\/admin\/login/);
    const stoppedAt=activityRequests;await page.clock.fastForward(20000);assert.equal(activityRequests,stoppedAt);
    cases.push({operation:'logout-clears-state-and-stops-activity-requests',status:'PASS'});
    assert.deepEqual(rejected,[]);assert.deepEqual(pageErrors,[]);
    return {mode,status:'PASS_IN_SCOPE',cases,apiRequests,activityRequests,browserVersion:browser.version(),
      apiResponsesMocked:false,sessionInjected:false,frontendViaNginx:true,networkScopeViolations:0,requestBudget:160};
  }finally{try{await context?.close();}finally{await browser.close();}}
}
