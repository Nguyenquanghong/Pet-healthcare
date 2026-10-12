import {expect,test,type Page} from '@playwright/test';

async function fixture(page:Page,role:'owner'|'admin'){
  const owner={id:'p4-ui-owner',fullName:'Fixture owner',phone:'fixture',petIds:['p4-ui-pet']};
  const pet={id:'p4-ui-pet',ownerId:owner.id,name:'Fixture pet',species:'dog',healthStatus:'healthy',allergies:[]};
  const appointment={id:'p4-ui-appointment',ownerId:owner.id,petId:pet.id,type:'spa_bath',serviceName:'Fixture Spa',date:'2026-10-12',time:'10:00',status:'completed',statusRevision:1};
  const invoice={id:'p4-ui-invoice',invoiceCode:'INV-FIXTURE',ownerId:owner.id,petId:pet.id,type:'appointment',appointmentId:appointment.id,subtotal:100000,totalAmount:100000,taxAmount:0,discountAmount:0,paymentStatus:'unpaid',items:[],issuedAt:'2026-10-11T01:00:00Z'};
  const state={currentOwnerId:role==='owner'?owner.id:'',owners:[owner],pets:[pet],appointments:[],medicalRecords:[],medicalImages:[],hotelBookings:[],dailyCareNotes:[],notifications:[],summary:{totals:{},species:{},appointmentStatus:{},hotelStatus:{},notificationCategory:{},unread:0,todayAppointments:0}};
  const control={lose:false,pending:true,failed:false,failRefresh:false,sends:[] as {key:string|undefined;body:unknown}[],polls:0};
  // All API/external URLs are intercepted; fixtures never reach a live backend.
  const payload=btoa(JSON.stringify({sub:role==='owner'?owner.id:'p4-ui-admin',role,iat:1}));
  await page.addInitScript(token=>sessionStorage.setItem('nipopeto_access_token',token),'fixture.'+payload+'.fixture');
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),json=(body:unknown,status=200)=>route.fulfill({status,json:body,headers:{'access-control-allow-origin':'*'}});
    if(!url.pathname.startsWith('/api/'))return url.origin==='http://127.0.0.1:5187'?route.continue():route.abort();
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}});
    if(url.pathname==='/api/auth/me')return json({user:{...owner,id:role==='owner'?owner.id:'p4-ui-admin',role}});
    if(url.pathname==='/api/bootstrap')return control.failRefresh?json({error:'Refresh unavailable'},503):json(state);
    if(url.pathname==='/api/notifications/unread-count')return json({unread:0,asOf:new Date().toISOString()});
    if(url.pathname==='/api/payments/options')return json({vnpayEnabled:false,bankTransfer:null});
    if(url.pathname==='/api/invoices/summary')return json({received:0,hotel:0,appointment:0,outstanding:0,paidCount:0,unpaidCount:0});
    if(url.pathname.startsWith('/api/operations/')){control.polls++;return json(control.failed?{operationId:'p4-ui-op',status:'failed',error:'Fixture definitive abort'}:control.pending?{operationId:'p4-ui-op',status:'pending'}:{operationId:'p4-ui-op',status:'succeeded',invoiceId:invoice.id,invoice});}
    if(req.method()==='GET'){const items=url.pathname==='/api/appointments'?[appointment]:url.pathname==='/api/pets'?[pet]:url.pathname==='/api/owners'?[owner]:url.pathname==='/api/invoices'&&!control.pending&&!control.failed?[invoice]:[];return control.failRefresh&&url.pathname==='/api/invoices'?json({error:'Page refresh unavailable'},503):json({items,pagination:{page:1,pageSize:20,total:items.length,totalPages:items.length?1:0},counts:{},related:{pets:[pet],owners:[owner],appointments:[]}});}
    if(req.method()==='POST'&&['/api/invoices','/api/invoices/checkout'].includes(url.pathname)){control.sends.push({key:req.headers()['idempotency-key'],body:req.postDataJSON()});if(control.lose){control.lose=false;return route.abort('failed');}return control.pending?json({operationId:'p4-ui-op',status:'pending'},202):json({invoice},role==='admin'?201:200);}
    return json({error:'Unexpected fixture API'},501);
  });return control;
}

test('staff 202 freezes charges; reload restores operation; poll commits without another POST',async({page})=>{
  const api=await fixture(page,'admin');await page.goto('/admin/billing');await page.getByRole('button',{name:'Lập hóa đơn',exact:true}).click();
  await page.getByRole('dialog').getByRole('combobox', {name:/Đơn cần chốt phí/}).selectOption('appointment:p4-ui-appointment');await page.getByRole('button',{name:'Lưu hóa đơn',exact:true}).click();
  await expect(page.getByRole('button',{name:'Kiểm tra trạng thái',exact:true})).toBeEnabled();await expect(page.getByRole('dialog').getByRole('combobox', {name:/Đơn cần chốt phí/})).toBeDisabled();expect(api.sends).toHaveLength(1);expect(api.sends[0].key).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();await page.getByRole('button',{name:'Lập hóa đơn',exact:true}).click();api.pending=false;await page.getByRole('button',{name:'Kiểm tra trạng thái',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(api.sends).toHaveLength(1);await expect(page.getByText('Đã lưu hóa đơn chờ thanh toán.',{exact:true})).toBeVisible();
});

test('owner response loss keeps key/body over reload; saved invoice plus refresh failure reports saved',async({page})=>{
  const api=await fixture(page,'owner');api.lose=true;await page.goto('/owner/billing');await page.getByRole('button',{name:'Xem phí và thanh toán',exact:true}).click();await expect.poll(()=>api.sends.length).toBe(1);await expect(page.getByRole('button',{name:'Kiểm tra trạng thái hóa đơn',exact:true})).toBeEnabled();
  await page.reload();api.pending=false;api.failRefresh=true;await page.getByRole('button',{name:'Kiểm tra trạng thái hóa đơn',exact:true}).click();await expect.poll(()=>api.sends.length).toBe(2);expect(api.sends[1]).toEqual(api.sends[0]);await expect(page.getByText('Đã ghi nhận thao tác nhưng chưa tải lại được dữ liệu. Kiểm tra trạng thái trước khi gửi lại.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Kiểm tra trạng thái hóa đơn',exact:true})).toHaveCount(0);
});

test('definitive aborted operation unlocks staff form and allows a new request key',async({page})=>{
  const api=await fixture(page,'admin');await page.goto('/admin/billing');await page.getByRole('button',{name:'Lập hóa đơn',exact:true}).click();await page.getByRole('dialog').getByRole('combobox', {name:/Đơn cần chốt phí/}).selectOption('appointment:p4-ui-appointment');await page.getByRole('button',{name:'Lưu hóa đơn',exact:true}).click();await expect(page.getByRole('button',{name:'Kiểm tra trạng thái',exact:true})).toBeEnabled();api.failed=true;await page.getByRole('button',{name:'Kiểm tra trạng thái',exact:true}).click();await expect(page.getByText('Fixture definitive abort',{exact:true})).toBeVisible();await expect(page.getByRole('dialog').getByRole('combobox', {name:/Đơn cần chốt phí/})).toBeEnabled();api.failed=false;api.pending=false;await page.getByRole('button',{name:'Lưu hóa đơn',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(api.sends).toHaveLength(2);expect(api.sends[0].key).not.toBe(api.sends[1].key);
});
