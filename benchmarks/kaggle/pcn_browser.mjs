import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const fixture = JSON.parse(await readFile(process.env.BENCH_FIXTURE, 'utf8'));
const output = process.env.PCN_BROWSER_OUTPUT;
const artifactDir = process.env.PCN_BROWSER_ARTIFACTS;
const baseURL = process.env.PCN_FRONTEND || 'http://127.0.0.1:5179';
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) throw new Error('PCN browser tests require loopback.');
await mkdir(artifactDir, { recursive: true });
const channels = (process.env.PCN_BROWSER_CHANNELS || 'chrome,msedge').split(',');
const paths = {
  owner: ['/owner/dashboard', '/owner/pets', '/owner/appointments', '/owner/medical-records', '/owner/hotel-booking', '/owner/billing'],
  admin: ['/admin/dashboard', '/admin/pets', '/admin/appointments', '/admin/medical-records', '/admin/hotel-bookings', '/admin/billing'],
};
const result = { versions: {}, cases: [], bookings: [], launch_errors: [],
  step_definition: 'From the appointment screen after login: select pet, select service, fill date, fill time, submit. One field selection/fill or confirmation is one step; individual keystrokes and login are excluded.' };

async function layout(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (overflow) throw new Error('Page overflows horizontally');
  const buttons = page.locator('main button, main a, main input, main select');
  let checked = 0;
  for (const button of await buttons.all()) {
    if (!await button.isVisible() || !await button.isEnabled()) continue;
    await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const accessible = await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
        && top !== null && (element.contains(top) || top.contains(element));
    });
    if (!accessible) throw new Error('An enabled main control is clipped or covered by another element');
    checked++;
  }
  if (!checked) throw new Error('No usable main controls were found');
  return checked;
}

for (const channel of channels) {
  let browser;
  try {
    browser = await chromium.launch({ channel, headless: true, args: ['--no-sandbox'] });
    result.versions[channel] = browser.version();
    for (const width of [390, 1366]) {
      for (const role of ['owner', 'admin']) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, timezoneId: 'Asia/Ho_Chi_Minh' });
        await context.addInitScript(token => sessionStorage.setItem('nipopeto_access_token', token),
          role === 'owner' ? fixture.users[0].token : fixture.adminToken);
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        for (const path of paths[role]) {
          const item = { channel, width, role, path, passed: false };
          const errorStart = errors.length;
          try {
            const response = await page.goto(baseURL + path);
            if (!response?.ok()) throw new Error('Frontend navigation failed');
            await expect(page.locator('main').first()).toBeVisible();
            await expect(page).toHaveURL(baseURL + path);
            if (path === '/owner/appointments') {
              await expect(page.getByLabel('Thú cưng', { exact: true })).toContainText('Synthetic pet');
              const booking = { channel, width, steps: [], passed: false };
              try {
                await page.getByLabel('Thú cưng', { exact: true }).selectOption(fixture.users[0].petId);
                booking.steps.push('Select pet');
                await page.getByLabel('Dịch vụ', { exact: true }).selectOption('general_checkup');
                booking.steps.push('Select service');
                await page.getByLabel('Ngày khám', { exact: true }).fill('2099-12-15');
                booking.steps.push('Fill date');
                const minute = result.bookings.length;
                await page.getByLabel('Giờ khám', { exact: true }).fill(`18:${String(minute).padStart(2, '0')}`);
                booking.steps.push('Fill time');
                const saved = page.waitForResponse(response => response.url().endsWith('/api/appointments') && response.request().method() === 'POST');
                await page.getByRole('button', { name: 'Gửi yêu cầu đặt lịch', exact: true }).click();
                booking.steps.push('Submit');
                const response = await saved;
                const body = await response.json();
                if (response.status() !== 201 || body.appointment?.petId !== fixture.users[0].petId) throw new Error('Appointment was not saved successfully');
                await expect(page.getByText('Đã gửi yêu cầu đặt lịch! Admin sẽ xác nhận sớm.', { exact: true })).toBeVisible();
                booking.passed = booking.steps.length <= 5;
              } catch (error) { booking.error = String(error.message).slice(0, 500); }
              result.bookings.push(booking);
              if (!booking.passed) throw new Error('Five-step booking failed');
            }
            item.enabled_controls_checked = await layout(page);
            if (errors.length > errorStart) throw new Error('Uncaught JavaScript error on page');
            item.passed = true;
          } catch (error) { item.error = String(error.message).slice(0, 500); }
          await page.screenshot({ path: join(artifactDir, `${channel}-${width}-${role}-${path.split('/').pop()}.png`), fullPage: true }).catch(() => {});
          result.cases.push(item);
        }
        await context.close();
      }
    }
  } catch (error) {
    result.launch_errors.push({ channel, error: String(error.message).slice(0, 500) });
  } finally { await browser?.close(); }
}
const allChannels = channels.includes('chrome') && channels.includes('msedge');
const bookingsPassed = result.bookings.length === 4 && result.bookings.every(x => x.passed);
result.PCN04 = { status: bookingsPassed && allChannels ? 'PASS_IN_SCOPE' : result.bookings.length ? 'FAIL' : 'NOT_RUN',
  scope: result.step_definition };
result.PCN05 = { status: result.cases.length === 48 && result.cases.every(x => x.passed) && allChannels && !result.launch_errors.length
  ? 'PASS_IN_SCOPE' : result.cases.length ? 'FAIL' : 'NOT_RUN',
  scope: 'Chrome and Edge, 390 and 1366 px, 12 listed owner/admin pages, enabled controls and four real appointment submissions. Does not certify every form or device.' };
await writeFile(output, JSON.stringify(result, null, 2));
console.log(`Browser evidence: ${result.cases.filter(x => x.passed).length}/${result.cases.length} pages; ${result.bookings.filter(x => x.passed).length}/${result.bookings.length} bookings`);
