import {test,expect} from '@playwright/test';
import {fixture,login,pickPet,api,controls,observed,browserOnlyLocal} from './helpers';
import {randomUUID} from 'node:crypto';

test('Q4 real projection: owner create/reschedule with paused worker, admin two windows status/undo/medical, logout isolation',async({page,context})=>{
  const f=fixture();expect((f as any).q4E2e).toBe(true);
  await login(page);await page.goto('/owner/appointments');const pet=await pickPet(page,0);
  await controls({pauseRead:true});await expect.poll(()=>observed().readPaused).toBe(true);
  await page.getByLabel('Ngày khám',{exact:true}).fill('2040-04-01');await page.getByLabel('Giờ khám',{exact:true}).fill('09:00');
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/appointments'&&r.request().method()==='POST');
  const after=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/appointments'&&r.request().method()==='GET'&&Boolean(r.request().headers()['x-clinic-min-version']));
  await page.getByRole('button',{name:'Gửi yêu cầu đặt lịch',exact:true}).click();const write=await saved;expect(write.status()).toBe(201);expect(Boolean(write.headers()['x-clinic-read-token'])).toBe(true);const a=(await write.json()).appointment;
  const read=await after;expect(read.headers()['x-clinic-read-source']).toBe('authoritative');expect((await read.json()).items.some((x:any)=>x.id===a.id)).toBe(true);
  await page.getByRole('button',{name:'Đổi lịch',exact:true}).click();await page.getByLabel('Ngày mới',{exact:true}).fill('2040-04-02');await page.getByLabel('Giờ mới',{exact:true}).fill('10:00');
  const moved=page.waitForResponse(r=>r.url().endsWith('/reschedule')&&r.request().method()==='PATCH');await page.getByRole('button',{name:'Xác nhận đổi',exact:true}).click();expect((await moved).status()).toBe(200);
  await controls({});await expect.poll(()=>observed().readPaused).toBe(false);
  // Real Core proxy must forward tokens, source metadata and cache isolation.
  const ownerToken=await page.evaluate(()=>sessionStorage.getItem('nipopeto_access_token'));
  await expect.poll(async()=>{const r=await page.request.get('/api/appointments?id='+a.id,{headers:{Authorization:'Bearer '+ownerToken}});return r.headers()['x-clinic-read-source'];}).toBe('projection');
  await login(page,'admin');await page.goto('/admin/appointments');await page.getByPlaceholder('Tìm theo tên thú cưng, chủ nuôi, sđt, dịch vụ...').fill(pet.name);
  const second=await context.newPage();await login(second,'admin');await second.goto('/admin/appointments');await second.getByPlaceholder('Tìm theo tên thú cưng, chủ nuôi, sđt, dịch vụ...').fill(pet.name);
  const row=page.getByRole('row').filter({hasText:pet.name}),row2=second.getByRole('row').filter({hasText:pet.name});
  await row.getByRole('button',{name:'Xác nhận',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Xác nhận: Đã xác nhận',exact:true}).click();await expect(row).toContainText('Đã xác nhận');await expect(row2).toContainText('Đã xác nhận');
  const checkIn=async()=>{await row.getByRole('button',{name:'Check-in',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Xác nhận đã nhận thú cưng',exact:true}).click();await expect(row).toContainText('Đã check-in');};
  await checkIn();await row.getByRole('button',{name:'Hoàn tác check-in',exact:true}).click();await page.getByLabel('Lý do hoàn tác').fill('Q4 trial');await page.getByRole('button',{name:'Xác nhận hoàn tác',exact:true}).click();await expect(row).toContainText('Đã xác nhận');await checkIn();
  await row.getByRole('button',{name:'Tạo bệnh án',exact:true}).click();const medical=page.getByRole('dialog',{name:'Tạo bệnh án từ lịch khám',exact:true});await medical.locator('input').first().fill('Q4 medical '+f.run.slice(0,8));await medical.getByPlaceholder('Nhập chẩn đoán y khoa...').fill('Synthetic');await medical.getByPlaceholder('Phương pháp điều trị...').fill('Synthetic');
  const completed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/medical-records'&&r.request().method()==='POST');await medical.getByRole('button',{name:'Lưu bệnh án & Hoàn thành lịch',exact:true}).click();expect((await completed).status()).toBe(201);await expect(row).toContainText('Hoàn thành');await expect(row2).toContainText('Hoàn thành');await second.close();
  expect((await api(page,'/appointments?petId='+pet.id,{role:'other'})).status).toBe(403);
  await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();expect(await page.evaluate(()=>sessionStorage.getItem('nipopeto_access_token'))).toBeNull();
  const oldHeaders:string[]=[];page.on('request',r=>{if(r.method()==='GET'&&new URL(r.url()).pathname==='/api/appointments')oldHeaders.push(r.headers()['x-clinic-min-version']??'');});
  await login(page,'other');await page.goto('/owner/appointments');await expect(page.getByText(pet.name,{exact:true})).toHaveCount(0);expect(oldHeaders.every(v=>!v)).toBe(true);await expect(page.getByText('Đã lưu thay đổi lịch hẹn',{exact:true})).toHaveCount(0);
});

test('Q4 delayed pre-mutation GET cannot replace the newer successful list',async({page})=>{
  await login(page);let release!:()=>void,ready!:()=>void,handled!:()=>void;
  const held=new Promise<void>(r=>release=r),captured=new Promise<void>(r=>ready=r),finished=new Promise<void>(r=>handled=r);let first=true;
  await page.route('**/api/appointments?**',async route=>{
    if(!first)return route.fallback();first=false;
    const response=await route.fetch();ready();await held;
    try{await route.fulfill({response});}catch{/* The superseded browser request may already be aborted. */}finally{handled();}
  });
  try{
    await page.goto('/owner/appointments');await captured;const pet=await pickPet(page,2);
    await page.getByLabel('Ngày khám',{exact:true}).fill('2040-04-04');await page.getByLabel('Giờ khám',{exact:true}).fill('12:00');
    const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/appointments'&&r.request().method()==='GET'&&Boolean(r.request().headers()['x-clinic-min-version']));
    await page.getByRole('button',{name:'Gửi yêu cầu đặt lịch',exact:true}).click();expect((await refreshed).status()).toBe(200);
    await expect(page.getByText(pet.name,{exact:true}).last()).toBeVisible();release();await finished;
    await expect(page.getByText(pet.name,{exact:true}).last()).toBeVisible();
  }finally{release();}
});

test('Q4 real commit remains visible when refresh fails; expired token retries only GET authoritative',async({page})=>{
  await login(page);await page.goto('/owner/appointments');await pickPet(page,1);await page.getByLabel('Ngày khám',{exact:true}).fill('2040-04-03');await page.getByLabel('Giờ khám',{exact:true}).fill('11:00');
  let committed=false,expired=false,posts=0;const reads:{token:boolean;source:boolean}[]=[];
  await page.route('**/api/appointments?**',async route=>{
    if(!committed)return route.fallback();const h=route.request().headers();reads.push({token:Boolean(h['x-clinic-min-version']),source:h['x-clinic-read-consistency']==='authoritative'});
    if(!expired)return route.fulfill({status:503,json:{error:'Q4 refresh unavailable'}});
    if(h['x-clinic-min-version'])return route.fulfill({status:422,json:{error:'Expired Clinic read token',code:'CLINIC_READ_TOKEN_INVALID'}});
    return route.continue();
  });
  page.on('response',r=>{if(new URL(r.url()).pathname==='/api/appointments'&&r.request().method()==='POST'){posts++;committed=r.status()===201;}});
  await page.getByRole('button',{name:'Gửi yêu cầu đặt lịch',exact:true}).click();await expect(page.getByText('Đã lưu thay đổi lịch hẹn',{exact:true})).toBeVisible();await expect(page.getByRole('alert').filter({hasText:'Q4 refresh unavailable'})).toBeVisible();
  expired=true;await page.getByRole('button',{name:'Thử lại',exact:true}).click();await expect.poll(()=>reads.some(r=>r.source&&!r.token)).toBe(true);expect(posts).toBe(1);await expect(page.getByText('Đã lưu thay đổi lịch hẹn',{exact:true})).toHaveCount(0);
});
