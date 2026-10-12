import { expect,test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fixture,browserOnlyLocal,network } from './helpers';
test('P4 built frontend request baseline against the real isolated services',async({page})=>{
  const f=fixture();await browserOnlyLocal(page);
  const sign=await page.request.post('/api/auth/admin/login',{data:{username:f.admin.username,password:f.password}});expect(sign.status()).toBe(200);const {token}=await sign.json();
  const boot=await page.request.get('/api/bootstrap?view=dashboard',{headers:{Authorization:'Bearer '+token}});expect(await boot.json()).toHaveProperty('summary');expect(boot.status()).toBe(200);
  await page.addInitScript(token=>sessionStorage.setItem('nipopeto_access_token',token),token);
  const calls=network(page),phases=[];
  try {for(const path of ['/admin/dashboard','/admin/appointments']){const start=calls.length;await page.goto(path);await expect(page.getByRole('heading',{name:path.endsWith('dashboard')?'Dashboard':'Quản lý lịch hẹn',exact:true})).toBeVisible();await page.waitForLoadState('networkidle');const idleStart=calls.length;await page.waitForTimeout(12000);phases.push({path,durationMs:12000,initial:calls.slice(start,idleStart),background:calls.slice(idleStart),calls:calls.slice(start)});}}
  finally {writeFileSync('test-results/phase2/p5-network-baseline-attempt.json',JSON.stringify({calls},null,2));}
  writeFileSync('test-results/phase2/p5-network-baseline.json',JSON.stringify({run:f.run,builtFrontend:'P4 snapshot before P5 edits',phases},null,2));
});
