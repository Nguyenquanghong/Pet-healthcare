import {expect,test,type Page} from '@playwright/test';

// Built React request/feedback checks. Every API is intercepted; real SQL,
// broker, ownership and two-process behavior are in clinic.test.mjs.
async function fixture(page:Page,role:'owner'|'admin'='owner'){
  const owner={id:'p3-ui-owner',fullName:'Fixture owner',phone:'000-fixture',petIds:['p3-ui-pet']};
  const pet={id:'p3-ui-pet',ownerId:owner.id,name:'Fixture pet',species:'dog',breed:'Fixture breed',healthStatus:'healthy',allergies:[],gender:'male',createdAt:new Date().toISOString()};
  const state={currentOwnerId:role==='owner'?owner.id:'',owners:[owner],pets:[pet],appointments:[],medicalRecords:[],medicalImages:[],hotelBookings:[],dailyCareNotes:[],notifications:[],summary:{totals:{},species:{},appointmentStatus:{},hotelStatus:{},notificationCategory:{},unread:0,todayAppointments:0}};
  const control={lose:true,failRefresh:false,hold:false,release:()=>{},sends:[] as {key:string|undefined;body:Record<string,unknown>}[],records:[] as Record<string,unknown>[],patches:[] as Record<string,unknown>[],patchReplies:[] as {status:number;body:unknown}[]};
  const doctor={id:'p3-ui-doctor',fullName:'Fixture doctor'};
  await page.addInitScript(()=>sessionStorage.setItem('nipopeto_access_token','p3-ui-fixture-token'));
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),json=(body:unknown,status=200)=>route.fulfill({status,json:body,headers:{'access-control-allow-origin':'*'}});
    if(!url.pathname.startsWith('/api/'))return url.origin==='http://127.0.0.1:5187'?route.continue():route.abort();
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}});
    if(url.pathname==='/api/auth/me')return json({user:{...owner,role}});
    if(url.pathname==='/api/bootstrap')return control.failRefresh?json({error:'Refresh fixture unavailable'},503):json(state);
    if(url.pathname==='/api/notifications/unread-count')return json({unread:0,asOf:new Date().toISOString()});
    if(url.pathname==='/api/doctors')return json({items:[doctor]});
    if(req.method()==='GET'){if(control.failRefresh&&url.pathname.startsWith('/api/medical-records'))return json({error:'Refresh fixture unavailable'},503);const items=url.pathname==='/api/pets'?[pet]:url.pathname==='/api/owners'?[owner]:url.pathname==='/api/medical-records'?control.records:[];return json({items,pagination:{page:1,pageSize:20,total:items.length,totalPages:1},counts:{},related:{pets:[pet],owners:[owner],appointments:[]}});}
    if(req.method()==='POST'&&['/api/appointments','/api/medical-records'].includes(url.pathname)){
      control.sends.push({key:req.headers()['idempotency-key'],body:req.postDataJSON()});if(control.hold)await new Promise<void>(r=>control.release=r);
      if(control.lose){control.lose=false;return route.abort('failed');}return json(url.pathname==='/api/appointments'?{appointment:{id:'p3-ui-appointment'}}:{record:{id:'p3-ui-record'}},201);
    }
    if(req.method()==='PATCH'&&url.pathname.startsWith('/api/medical-records/')){control.patches.push(req.postDataJSON());const reply=control.patchReplies.shift()??{status:200,body:{record:control.records[0]}};return json(reply.body,reply.status);}
    return json({error:'Unexpected fixture route'},501);
  });return control;
}
for(const spa of [false,true])test(`${spa?'Spa':'exam'} form preserves key through response loss and locks an in-flight submit`,async({page})=>{
  const api=await fixture(page);await page.goto(spa?'/owner/spa-booking':'/owner/appointments');
  const name=spa?'Gửi yêu cầu đặt Spa':'Gửi yêu cầu đặt lịch',submit=page.getByRole('button',{name,exact:true});await expect(submit).toBeEnabled();await submit.click();await expect.poll(()=>api.sends.length).toBe(1);await expect(submit).toBeEnabled();
  api.hold=true;await submit.click();await expect.poll(()=>api.sends.length).toBe(2);await expect(page.getByRole('button',{name:'Đang gửi yêu cầu...',exact:true})).toBeDisabled();expect(api.sends[0].key).toMatch(/^[0-9a-f-]{36}$/);expect(api.sends[1]).toEqual(api.sends[0]);api.release();
  await expect(page.getByText(spa?'Yêu cầu Spa đã được gửi và đang chờ xác nhận.':'Đã gửi yêu cầu đặt lịch! Admin sẽ xác nhận sớm.',{exact:true})).toBeVisible();
});
test('medical form retries same intent; saved record with refresh failure closes create form and reports saved',async({page})=>{
  const api=await fixture(page,'admin');await page.goto('/admin/medical-records');await page.getByRole('button',{name:'Tạo hồ sơ mới',exact:true}).click();
  await page.getByPlaceholder('VD: Khám tổng quát định kỳ',{exact:true}).fill('Fixture record');await page.getByPlaceholder('Kết quả chẩn đoán...', {exact:true}).fill('Fixture diagnosis');await page.getByPlaceholder('Hướng điều trị...', {exact:true}).fill('Fixture treatment');
  await page.getByLabel('Bác sĩ phụ trách',{exact:true}).selectOption('p3-ui-doctor');
  const save=page.getByRole('button',{name:'Lưu hồ sơ y tế',exact:true});await save.click();await expect.poll(()=>api.sends.length).toBe(1);expect(api.sends[0].body.doctorId).toBe('p3-ui-doctor');expect(api.sends[0].body).not.toHaveProperty('doctorName');await expect(page.getByRole('alert')).toBeVisible();api.failRefresh=true;await save.click();
  await expect(page.getByText('Đã lưu bệnh án nhưng chưa tải lại được dữ liệu. Hãy tải lại để đối chiếu.',{exact:true})).toBeVisible();await expect(save).toHaveCount(0);expect(api.sends).toHaveLength(2);expect(api.sends[0].key).toMatch(/^[0-9a-f-]{36}$/);expect(api.sends[1]).toEqual(api.sends[0]);
});
test('medical edit sends only changed fields with the loaded revision; a stale save keeps the draft and applies it onto the newer record',async({page})=>{
  const api=await fixture(page,'admin');
  const loaded={id:'p3-ui-record',petId:'p3-ui-pet',ownerId:'p3-ui-owner',appointmentId:null,doctorId:'p3-ui-doctor',doctorName:'Fixture doctor',revision:4,visitDate:'2030-01-01',title:'Loaded title',symptoms:null,diagnosis:'Loaded diagnosis',treatment:'Loaded treatment',medications:null,vaccineName:'Rabies',weightKg:4.2,heartRateBpm:90,createdAt:'2030-01-01T00:00:00.000Z',updatedAt:'2030-01-01T00:00:00.000Z'};
  const newer={...loaded,revision:5,treatment:'Colleague treatment'};
  api.records.push(loaded);api.patchReplies.push({status:409,body:{error:'Bệnh án vừa được người khác cập nhật. Hãy xem bản mới trước khi lưu.',code:'MEDICAL_RECORD_STALE',current:newer}});
  await page.goto('/admin/medical-records');await page.getByTitle('Chỉnh sửa',{exact:true}).click();
  await expect(page.getByText('Người lập bệnh án được cố định khi tạo.',{exact:true})).toBeVisible();
  await page.getByLabel('Chẩn đoán',{exact:true}).fill('My diagnosis');await page.getByLabel('Tên vaccine',{exact:true}).fill('');await page.getByLabel('Cân nặng (kg)',{exact:true}).fill('');
  const update=page.getByRole('button',{name:'Cập nhật hồ sơ',exact:true});await update.click();
  await expect.poll(()=>api.patches.length).toBe(1);
  // Cleared optional fields go as null; untouched fields are not sent.
  expect(api.patches[0]).toEqual({expectedRevision:4,diagnosis:'My diagnosis',vaccineName:null,weightKg:null});
  const panel=page.getByRole('region',{name:'Bản mới của bệnh án'});
  await expect(panel).toContainText('Hướng điều trị: Loaded treatment → Colleague treatment');
  await expect(page.getByLabel('Chẩn đoán',{exact:true})).toHaveValue('My diagnosis');
  await panel.getByRole('button',{name:'Áp thay đổi của tôi lên bản mới',exact:true}).click();
  await expect(page.getByLabel('Hướng điều trị',{exact:true})).toHaveValue('Colleague treatment');await expect(page.getByLabel('Chẩn đoán',{exact:true})).toHaveValue('My diagnosis');await expect(page.getByLabel('Tên vaccine',{exact:true})).toHaveValue('');
  await update.click();await expect.poll(()=>api.patches.length).toBe(2);
  expect(api.patches[1]).toEqual({expectedRevision:5,diagnosis:'My diagnosis',vaccineName:null,weightKg:null});
  await expect(page.getByText('Đã cập nhật hồ sơ y tế thành công.',{exact:true})).toBeVisible();
});
test('a stale medical edit can also be dropped for the newer record',async({page})=>{
  const api=await fixture(page,'admin');
  const loaded={id:'p3-ui-record',petId:'p3-ui-pet',ownerId:'p3-ui-owner',appointmentId:null,doctorId:'p3-ui-doctor',doctorName:'Fixture doctor',revision:1,visitDate:'2030-01-01',title:'Loaded title',symptoms:null,diagnosis:'Loaded diagnosis',treatment:'Loaded treatment',medications:null,vaccineName:null,heartRateBpm:null,createdAt:'2030-01-01T00:00:00.000Z',updatedAt:'2030-01-01T00:00:00.000Z'};
  api.records.push(loaded);api.patchReplies.push({status:409,body:{error:'stale',code:'MEDICAL_RECORD_STALE',current:{...loaded,revision:2,diagnosis:'Colleague diagnosis'}}});
  await page.goto('/admin/medical-records');await page.getByTitle('Chỉnh sửa',{exact:true}).click();
  await page.getByLabel('Chẩn đoán',{exact:true}).fill('My diagnosis');await page.getByRole('button',{name:'Cập nhật hồ sơ',exact:true}).click();
  const panel=page.getByRole('region',{name:'Bản mới của bệnh án'});await expect(panel).toContainText('(bạn sửa thành: My diagnosis)');
  await panel.getByRole('button',{name:'Dùng bản mới',exact:true}).click();
  await expect(page.getByLabel('Chẩn đoán',{exact:true})).toHaveValue('Colleague diagnosis');await expect(panel).toHaveCount(0);
  expect(api.patches).toHaveLength(1);
});
