import { expect,test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { fixture,login,api,pickPet,transition,network,browserOnlyLocal } from './helpers';
test('registration keeps server validation and success feedback across the new session boundary',async({page})=>{
  const f=fixture();await browserOnlyLocal(page);await page.goto('/register');await page.getByLabel('Email *',{exact:true}).fill(f.owner.email);await page.getByLabel('Password *',{exact:true}).fill(f.password);await page.getByLabel('Confirm password *',{exact:true}).fill(f.password);const rejected=page.waitForResponse(r=>r.url().endsWith('/api/auth/owner/register'));await page.getByRole('button',{name:'Create owner account',exact:true}).click();const r=await rejected;expect(r.status()).toBe(409);await expect(page.getByText((await r.json()).error,{exact:true})).toBeVisible();
  await page.getByLabel('Full name',{exact:true}).fill('P5 signup '+f.run.slice(0,8));await page.getByLabel('Email *',{exact:true}).fill('p5_signup_'+f.run.slice(0,8)+'@example.test');await page.getByLabel('Password *',{exact:true}).fill(f.password);await page.getByLabel('Confirm password *',{exact:true}).fill(f.password);const signed=page.waitForResponse(r=>r.url().endsWith('/api/auth/owner/register'));await page.getByRole('button',{name:'Create owner account',exact:true}).click();expect((await signed).status()).toBe(201);await expect(page.getByText('Account created successfully. Redirecting to add your pet profile...',{exact:true})).toBeVisible();await expect(page).toHaveURL(/owner\/pets$/);expect(await page.evaluate(()=>Boolean(sessionStorage.getItem('nipopeto_access_token')))).toBe(true);
});

test('owner books exam; staff checks in and atomically completes it with a medical record; owner reads redacted data',async({page})=>{
  const f=fixture();await login(page);await page.goto('/owner/appointments');const pet=await pickPet(page,0);
  await page.getByLabel('Ngày khám',{exact:true}).fill('2040-01-01');await page.getByLabel('Giờ khám',{exact:true}).fill('09:00');
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/appointments'&&r.request().method()==='POST');await page.getByRole('button',{name:'Gửi yêu cầu đặt lịch',exact:true}).click();const r=await saved;expect(r.status()).toBe(201);const a=(await r.json()).appointment;
  await expect(page.getByText('Đã gửi yêu cầu đặt lịch! Admin sẽ xác nhận sớm.',{exact:true})).toBeVisible();
  await login(page,'admin');await page.goto('/admin/appointments');await page.getByPlaceholder('Tìm theo tên thú cưng, chủ nuôi, sđt, dịch vụ...').fill(pet.name);
  const row=page.getByRole('row').filter({hasText:pet.name});await row.getByRole('button',{name:'Xác nhận',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Xác nhận: Đã xác nhận',exact:true}).click();await expect(row).toContainText('Đã xác nhận');
  await row.getByRole('button',{name:'Check-in',exact:true}).click();const d=page.getByRole('dialog',{name:'Xác nhận đã nhận thú cưng',exact:true});await expect(d).toContainText(f.owner.fullName);await expect(d).toContainText(a.id);await d.getByRole('button',{name:'Xác nhận đã nhận thú cưng',exact:true}).click();
  await row.getByRole('button',{name:'Tạo bệnh án',exact:true}).click();const medical=page.getByRole('dialog',{name:'Tạo bệnh án từ lịch khám',exact:true});
  const title='P5 exam record '+f.run.slice(0,8);await medical.getByLabel('Bác sĩ phụ trách',{exact:true}).selectOption(f.doctor.id);await medical.locator('input').first().fill(title);await medical.getByPlaceholder('Nhập chẩn đoán y khoa...').fill('Synthetic diagnosis');await medical.getByPlaceholder('Phương pháp điều trị...').fill('Synthetic treatment');
  const intents:{key:string|undefined;body:unknown}[]=[];let lost=false;
  await page.route('**/api/medical-records',async route=>{if(route.request().method()!=='POST')return route.fallback();intents.push({key:route.request().headers()['idempotency-key'],body:route.request().postDataJSON()});if(!lost){const committed=await route.fetch();expect(committed.status()).toBe(201);lost=true;return route.abort('failed');}return route.continue();});
  await medical.getByRole('button',{name:'Lưu bệnh án & Hoàn thành lịch',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Cannot connect');
  const recordResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/medical-records'&&r.request().method()==='POST');await medical.getByRole('button',{name:'Lưu bệnh án & Hoàn thành lịch',exact:true}).click();expect((await recordResponse).status()).toBe(201);await expect(medical).toHaveCount(0);
  expect(intents).toHaveLength(2);expect(intents[0].key).toMatch(/^[0-9a-f-]{36}$/);expect(intents[1]).toEqual(intents[0]);expect((await api(page,'/medical-records?petId='+pet.id,{role:'owner'})).body.items).toHaveLength(1);
  const read=await api(page,'/appointments?id='+a.id,{role:'owner'});expect(read.body.items[0].status).toBe('completed');expect(read.body.items[0]).not.toHaveProperty('internalNote');
  await login(page);await page.goto('/owner/medical-records?petId='+pet.id);await expect(page.getByText(title,{exact:true})).toBeVisible();expect((await api(page,'/medical-records?petId='+pet.id,{role:'other'})).status).toBe(403);
});

test('owner books Spa; staff completes it; checkout issues one real reserved invoice and cash is reflected for owner',async({page})=>{
  const f=fixture();await login(page);await page.goto('/owner/spa-booking');const pet=await pickPet(page,1,'Thú cưng *');await page.getByLabel('Ngày Spa *',{exact:true}).fill('2040-01-02');await page.getByRole('combobox',{name:'Khung giờ *',exact:true}).selectOption('10:30');
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/appointments'&&r.request().method()==='POST');await page.getByRole('button',{name:'Gửi yêu cầu đặt Spa',exact:true}).click();expect((await saved).status()).toBe(201);let a=(await(await saved).json()).appointment;
  for(const s of ['confirmed','checked_in','in_progress','completed'])a=await transition(page,a,s);
  await page.goto('/owner/billing');const source=page.getByRole('article').filter({hasText:pet.name});const issued=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/invoices/checkout'&&r.request().method()==='POST');await source.getByRole('button',{name:'Xem phí và thanh toán',exact:true}).click();const response=await issued;expect([200,202]).toContain(response.status());
  await expect.poll(async()=>{const x=await api(page,'/invoices?petId='+pet.id,{role:'owner'});return x.body.items.length;}).toBe(1);const invoice=(await api(page,'/invoices?petId='+pet.id,{role:'owner'})).body.items[0];
  await expect(page.getByRole('article',{name:invoice.invoiceCode,exact:true})).toBeVisible();
  await login(page,'admin');await page.goto('/admin/billing');await page.getByPlaceholder('Tìm mã hóa đơn / chuyển khoản, chủ nuôi, thú cưng...').fill(invoice.invoiceCode);const row=page.getByRole('row').filter({hasText:invoice.invoiceCode});await row.getByRole('button',{name:'Thanh toán',exact:true}).click();const payment=page.getByRole('dialog',{name:'Xác nhận đã thu tiền',exact:true});await payment.getByLabel('Phương thức thanh toán').selectOption('cash');await payment.getByRole('button',{name:'Xác nhận đã thu đủ tiền',exact:true}).click();
  await login(page);await page.goto('/owner/billing');await expect(page.getByRole('article',{name:invoice.invoiceCode,exact:true})).toContainText('Đã thanh toán');expect((await api(page,'/invoices?petId='+pet.id,{role:'owner'})).body.items).toHaveLength(1);
});

test('hotel booking, care notes, financial guard and owner detail remain usable with Core ownership',async({page})=>{
  await login(page);await page.goto('/owner/hotel-booking');const pet=await pickPet(page,2);await page.getByLabel('Ngày nhận phòng').fill('2040-02-01');await page.getByLabel('Ngày trả phòng').fill('2040-02-03');
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/hotel-bookings'&&r.request().method()==='POST');await page.getByRole('button',{name:'Xác nhận đặt phòng',exact:true}).click();const r=await saved;expect(r.status()).toBe(201);let b=(await r.json()).booking;
  b=await transition(page,b,'confirmed','hotel-bookings');b=await transition(page,b,'in_stay','hotel-bookings');
  const note='P5 care '+fixture().run.slice(0,8),care=await api(page,`/hotel-bookings/${b.id}/care-notes`,{method:'POST',body:{note}});expect(care.status).toBe(201);
  await page.goto('/owner/hotel-bookings/'+b.id);await expect(page.getByText(pet.name,{exact:true}).first()).toBeVisible();await page.getByText('Nhật ký chăm sóc hàng ngày',{exact:true}).click();await expect(page.getByText(note,{exact:true})).toBeVisible();
  const forbidden=await api(page,'/invoices/checkout',{method:'POST',role:'owner',key:randomUUID(),body:{type:'hotel_booking',relatedId:b.id}});expect(forbidden.status).toBe(403);
  await login(page,'admin');await page.goto('/admin/billing?hotelBookingId='+b.id);const issue=page.getByRole('dialog',{name:'Lập hóa đơn',exact:true});await expect(issue.getByRole('button',{name:'Lưu hóa đơn',exact:true})).toBeEnabled();const billResponse=page.waitForResponse(r=>r.url().endsWith('/api/invoices')&&r.request().method()==='POST');await issue.getByRole('button',{name:'Lưu hóa đơn',exact:true}).click();const bill=await billResponse;expect(bill.status()).toBe(201);const i=(await bill.json()).invoice;
  expect((await api(page,`/hotel-bookings/${b.id}/status`,{method:'PATCH',body:{status:'checked_out',expectedRevision:b.statusRevision}})).status).toBe(409);
  expect((await api(page,`/invoices/${i.id}/pay`,{method:'PATCH',body:{paymentMethod:'cash'}})).status).toBe(200);b=await transition(page,b,'checked_out','hotel-bookings');await login(page);await page.goto('/owner/hotel-bookings/'+b.id);await expect(page.getByText('Đã trả thú cưng',{exact:true}).first()).toBeVisible();
});

test('counter customer activation through UI retains owner, pet and clinical history',async({page})=>{
  const f=fixture(),email='p5_activated_'+f.run.slice(0,8)+'@example.test';
  const history=await api(page,'/appointments',{method:'POST',key:randomUUID(),body:{petId:f.counterPetId,type:'general_checkup',serviceName:'Counter history',date:'2040-03-01',time:'11:00'}});expect(history.status).toBe(201);
  await login(page,'admin');await page.goto('/admin/owners');await page.getByLabel('Tìm khách hàng').fill(f.counter.fullName);const row=page.locator('tbody tr').filter({hasText:f.counter.fullName});await row.getByRole('button',{name:'Kích hoạt tài khoản',exact:true}).click();const d=page.getByRole('dialog');await d.getByLabel('Email đăng nhập của khách').fill(email);await d.getByRole('checkbox').check();await d.getByRole('button',{name:'Cấp liên kết kích hoạt',exact:true}).click();const link=d.getByLabel('Liên kết kích hoạt');await expect(link).toHaveValue(/activate-account#token=/);const url=await link.inputValue(),token=url.split('#token=')[1];
  await page.goto(url);await page.getByLabel('Mật khẩu mới',{exact:true}).fill(f.password);await page.getByLabel('Xác nhận mật khẩu',{exact:true}).fill(f.password);await page.getByRole('button',{name:'Đặt mật khẩu và kích hoạt',exact:true}).click();await expect(page.getByRole('status')).toContainText('Đã kích hoạt tài khoản');
  expect((await page.request.post('/api/auth/owner/activation/inspect',{data:{token}})).status()).toBe(422);
  await page.goto('/login');await page.getByLabel('Email *',{exact:true}).fill(email);await page.getByLabel('Password *',{exact:true}).fill(f.password);const signed=page.waitForResponse(r=>r.url().endsWith('/api/auth/owner/login'));await page.getByRole('button',{name:'Sign in',exact:true}).click();expect((await(await signed).json()).user.id).toBe(f.counter.id);await expect(page).toHaveURL(/owner\/dashboard$/);await page.goto('/owner/appointments');await expect(page.getByText('Counter history',{exact:true})).toBeVisible();
});

test('public rescue UI exposes only allowed profile and delivers report through the actual outbox and inbox',async({page})=>{
  const f=fixture(),pet=f.pets[3];await browserOnlyLocal(page);const profile=await page.request.get('/api/public/pets/'+pet.qrToken);expect(profile.status()).toBe(200);const body=await profile.json();expect(body.owner.email).toBeUndefined();expect(body.pet).not.toHaveProperty('medicalRecords');expect(body.pet).not.toHaveProperty('ownerId');
  await page.goto('/rescue/'+pet.qrToken);await expect(page.getByRole('heading',{name:pet.name,exact:true})).toBeVisible();const place='P5 rescue '+f.run.slice(0,8);await page.getByLabel('Số điện thoại liên hệ *').fill('0901234567');await page.getByLabel('Vị trí tìm thấy *').fill(place);await page.getByRole('button',{name:'Gửi cho chủ nuôi',exact:true}).click();await expect(page.getByRole('heading',{name:'Đã gửi thông tin cho chủ nuôi',exact:true})).toBeVisible();
  await expect.poll(async()=>{const n=await api(page,'/notifications?q='+encodeURIComponent(place),{role:'owner'});return n.body.pagination.total;}).toBe(1);await login(page);await page.goto('/owner/notifications');await expect(page.getByText(new RegExp(place))).toBeVisible();
});

test('paged pet selector keeps a page-two selection; debounced search and server filters use real page data',async({page})=>{
  const f=fixture();await login(page);await page.goto('/owner/spa-booking');const select=page.getByRole('combobox',{name:'Thú cưng *',exact:true}),nav=select.locator('xpath=../..').getByRole('navigation',{name:'Phân trang',exact:true});await expect(select.locator('option')).toHaveCount(21);await nav.getByRole('button',{name:'Trang sau',exact:true}).click();await expect(nav).toContainText('Trang 2/2');await select.selectOption(f.pets[0].id);await nav.getByRole('button',{name:'Trang trước',exact:true}).click();await expect(select).toHaveValue(f.pets[0].id);await expect(select.locator('option').first()).not.toHaveValue(f.pets[0].id);
  const calls=network(page),input=page.getByRole('textbox',{name:'Thú cưng * — tìm kiếm',exact:true});await input.fill('P');await input.fill('P5');await input.fill(f.pets[0].name);await expect(nav).toContainText('1–1 / 1 kết quả');expect(calls.filter(r=>r.path==='/api/pets')).toHaveLength(1);await expect(select).toHaveValue(f.pets[0].id);
});

test('Vietnam date boundary is preserved in default forms and calendar request range',async({page})=>{
  await page.clock.install({time:new Date('2039-06-01T20:00:00Z')});await login(page);const calendar=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/appointments/calendar');await page.goto('/owner/appointments');await expect(page.getByLabel('Ngày khám',{exact:true})).toHaveValue('2039-06-03');expect(new URL((await calendar).url()).searchParams.get('month')).toBe('2039-06');await page.goto('/owner/spa-booking');await expect(page.getByLabel('Ngày Spa *',{exact:true})).toHaveAttribute('min','2039-06-02');
});

test('P5 request evidence for the same real dashboard and appointments flows',async({page})=>{
  await page.addInitScript(()=>{(window as any).__e2eReactModes=[];(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:(renderer:any)=>{(window as any).__e2eReactModes.push(renderer.bundleType);return 1;},onCommitFiberRoot:()=>{},onCommitFiberUnmount:()=>{}};});
  const f=fixture();await browserOnlyLocal(page);const sign=await page.request.post('/api/auth/admin/login',{data:{username:f.admin.username,password:f.password}});expect(sign.status()).toBe(200);const {token}=await sign.json();await page.addInitScript(token=>sessionStorage.setItem('nipopeto_access_token',token),token);const calls=network(page),phases=[];
  for(const path of ['/admin/dashboard','/admin/appointments']){const start=calls.length;await page.goto(path);await expect(page.getByRole('heading',{name:path.endsWith('dashboard')?'Dashboard':'Quản lý lịch hẹn',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__e2eReactModes)).toEqual([0]);await page.waitForLoadState('networkidle');const idleStart=calls.length;await page.waitForTimeout(12000);phases.push({path,durationMs:12000,initial:calls.slice(start,idleStart),background:calls.slice(idleStart),calls:calls.slice(start)});}
  const before=JSON.parse(readFileSync(existsSync('test-results/phase2/p5-network-baseline.json')?'test-results/phase2/p5-network-baseline.json':'phase2-plan/evidence/p5-network-before.json','utf8'));
  writeFileSync('test-results/phase2/p5-network-after.json',JSON.stringify({run:f.run,phases,historicalComparison:{
    beforeRequests:before.phases.reduce((n:number,p:any)=>n+p.calls.length,0),afterRequests:calls.length,
    comparable:false,reason:'Current Admin pages intentionally poll scoped resources every 5s; the old bootstrap workload differs.'}},null,2));
  expect(calls.some(r=>r.path==='/api/bootstrap')).toBe(false);
  // Session fencing may cancel its superseded initial /me request. Record its
  // actual terminal failure; never accept an unknown/pending or failed business
  // request. The replacement /me must finish with 200 on each navigation.
  const canceledSession=(r:typeof calls[number])=>r.outcome==='failed'&&r.failure==='net::ERR_ABORTED'&&r.method==='GET'&&r.path==='/api/auth/me';
  expect(calls.every(r=>r.outcome==='finished'&&r.status===200||canceledSession(r))).toBe(true);
  for(const phase of phases){expect(phase.initial.some(r=>r.path==='/api/auth/me'&&r.outcome==='finished'&&r.status===200)).toBe(true);expect(phase.initial.filter(canceledSession).length).toBeLessThanOrEqual(1);}
  // Admin refresh across windows is intentional. Assert the current bounded,
  // scoped polling contract instead of the obsolete zero-background contract.
  for(const phase of phases){
    const expected=phase.path==='/admin/dashboard'
      ? ['/api/dashboard/core','/api/dashboard/clinic','/api/notifications/unread-count']
      : ['/api/appointments','/api/notifications/unread-count'];
    expect(phase.background.every(r=>r.method==='GET'&&expected.includes(r.path))).toBe(true);
    for(const path of expected){
      const count=phase.background.filter(r=>r.path===path).length;
      expect(count,`${phase.path}: ${path} must refresh`).toBeGreaterThanOrEqual(1);
      // 5s polling with 15% jitter in a 12s observation window; no request storm.
      expect(count,`${phase.path}: ${path} polling is bounded`).toBeLessThanOrEqual(3);
      expect(phase.initial.filter(r=>r.path===path)).toHaveLength(1);
    }
  }
});
