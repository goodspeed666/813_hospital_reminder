// 在真的 Chromium 裡跑 PWA：檢查渲染、選診間、設定號碼、跨日清除
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const BASE = 'http://127.0.0.1:8910';

let failed = 0;
const check = (n, c, d) => {
  if (c) console.log('  ✓ ' + n);
  else {
    failed++;
    console.log('  ✗ ' + n + (d ? '  → ' + d : ''));
  }
};

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})
  .format(new Date())
  .replace(/-/g, '');

const mkRows = (progress) => [
  { SCD_VISITDT: TODAY, SHI_EASYNAME: '上午', SEC_SENAME: '內科', EMP_EMPNAME: '王小明', ROM_RONAME: '內科一診', CLC_MAXIMUM: '看診結束', CLC_VISITNO_NOW: '4' },
  { SCD_VISITDT: TODAY, SHI_EASYNAME: '下午', SEC_SENAME: '家庭醫學科', EMP_EMPNAME: '陳志豪', ROM_RONAME: '家醫內科一診', CLC_MAXIMUM: progress, CLC_VISITNO_NOW: progress },
  { SCD_VISITDT: TODAY, SHI_EASYNAME: '下午', SEC_SENAME: '復健科', EMP_EMPNAME: '林淑芬', ROM_RONAME: '復健科二診', CLC_MAXIMUM: '118', CLC_VISITNO_NOW: '118' },
  { SCD_VISITDT: TODAY, SHI_EASYNAME: '晚上', SEC_SENAME: '骨科', EMP_EMPNAME: '張建國', ROM_RONAME: '骨科二診', CLC_MAXIMUM: '-', CLC_VISITNO_NOW: '-' }
];

let progress = '50';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox']
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  permissions: ['notifications'],
  isMobile: true,
  hasTouch: true
});

// 攔截 Worker API
await ctx.route('**/api/**', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/api/config') {
    return route.fulfill({ json: { vapidPublicKey: null, pushEnabled: false, today: TODAY } });
  }
  if (u.pathname === '/api/progress') {
    return route.fulfill({
      json: { ok: true, fetchedAt: Date.now(), date: TODAY, rows: mkRows(progress) }
    });
  }
  return route.fulfill({ json: { ok: true } });
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|manifest/i.test(m.text())) errs.push('console: ' + m.text());
});

console.log('\n啟動與空狀態');
await page.goto(BASE + '/index.html?api=' + BASE);
await page.waitForTimeout(1200);
check('沒有 JS 執行錯誤', errs.length === 0, errs.join(' | '));
check('顯示空狀態引導', (await page.locator('.empty').count()) === 1);
check('標題顯示今天日期', (await page.innerText('#day-tag')) === `${TODAY.slice(4, 6)}/${TODAY.slice(6, 8)}`);
check('狀態列顯示更新時間', /\d{2}:\d{2}:\d{2} 更新/.test(await page.innerText('#status')), await page.innerText('#status'));
check('未選診間時設定面板隱藏', await page.locator('#alert-panel').isHidden());

console.log('\n選診間');
await page.click('#btn-add');
await page.waitForTimeout(400);
check('彈出選單開啟', await page.locator('#sheet').isVisible());
check('列出全部 4 個診間', (await page.locator('.clinic').count()) === 4, String(await page.locator('.clinic').count()));
check('時段分頁為 全部/上午/下午/晚上', (await page.locator('.tab').count()) === 4);
check('顯示目前叫號', (await page.locator('.clinic', { hasText: '家醫內科一診' }).locator('.pg').innerText()) === '50');

await page.click('.tab:has-text("下午")');
await page.waitForTimeout(250);
check('切到下午只剩 2 診', (await page.locator('.clinic').count()) === 2, String(await page.locator('.clinic').count()));
await page.fill('#search', '家醫');
await page.waitForTimeout(250);
check('搜尋可過濾', (await page.locator('.clinic').count()) === 1);

console.log('\n設定我的號碼');
await page.click('.clinic:has-text("家醫內科一診")');
await page.waitForTimeout(400);
check('自動跳出號碼設定', await page.locator('#num-sheet').isVisible());
check('標題為該診間', (await page.innerText('#num-title')) === '家醫內科一診');
await page.fill('#num-input', '53');
await page.fill('#num-threshold', '3');
await page.click('#num-save');
await page.waitForTimeout(400);

check('監看清單出現 1 筆', (await page.locator('.item').count()) === 1);
check('顯示目前叫號 50', (await page.locator('.item .big').innerText()) === '50');
check('算出還有 3 位', (await page.innerText('.item-right')).includes('3'), await page.innerText('.item-right'));
check('剩 3 號 → 整列變橘色警示', (await page.locator('.item.near').count()) === 1);
check('設定面板出現', await page.locator('#alert-panel').isVisible());

console.log('\n進度變動與狀態');
progress = '53';
await page.click('#btn-refresh');
await page.waitForTimeout(900);
check('叫號更新為 53', (await page.locator('.item .big').innerText()) === '53');
check('輪到你了 → 整列變紅', (await page.locator('.item.turn').count()) === 1, await page.innerText('.item-right'));

progress = '看診結束';
await page.click('#btn-refresh');
await page.waitForTimeout(900);
check('顯示看診結束', (await page.innerText('.item .big')).includes('看診結束'));

console.log('\n資料保存與跨日清除');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('813pwa.v1')));
check('監看清單有存進 localStorage', stored.watches.length === 1 && stored.watches[0].myNumber === 53, JSON.stringify(stored.watches));
check('存了當天日期', stored.day === TODAY, stored.day);

// 把日期改成昨天，重新載入 → 應該自動清除
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('813pwa.v1'));
  s.day = '20200101';
  localStorage.setItem('813pwa.v1', JSON.stringify(s));
});
await page.reload();
await page.waitForTimeout(1200);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem('813pwa.v1')));
check('跨日後監看清單被清空', after.watches.length === 0, JSON.stringify(after.watches));
check('跨日後比對狀態被清空', Object.keys(after.states).length === 0);
check('日期更新為今天', after.day === TODAY);
check('偏好設定保留', after.prefs && typeof after.prefs.sound === 'boolean');
check('畫面回到空狀態', (await page.locator('.empty').count()) === 1);

console.log('\n手動清除今日紀錄');
await page.click('#btn-add');
await page.waitForTimeout(300);
await page.click('.clinic:has-text("復健科二診")');
await page.waitForTimeout(300);
await page.click('#num-save');
await page.waitForTimeout(300);
check('重新加入 1 筆', (await page.locator('.item').count()) === 1);
await page.click('#btn-clear');
await page.waitForTimeout(400);
check('按下清除後歸零', (await page.locator('.item').count()) === 0);

console.log('\nPWA 基本要件');
const mani = await page.evaluate(async () => {
  const r = await fetch('manifest.webmanifest');
  return r.json();
});
check('manifest 有 name / start_url / display', !!mani.name && !!mani.start_url && mani.display === 'standalone');
check('manifest 含 192 與 512 圖示', mani.icons.some((i) => i.sizes === '192x192') && mani.icons.some((i) => i.sizes === '512x512'));
check('manifest 含 maskable 圖示', mani.icons.some((i) => i.purpose === 'maskable'));
const swReg = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r));
check('service worker 已註冊', swReg);
check('全程沒有 JS 錯誤', errs.length === 0, errs.join(' | '));

await page.screenshot({ path: '/tmp/test/pwa-empty.png' });
// 補一張有資料的畫面
progress = '50';
await page.click('#btn-add');
await page.waitForTimeout(300);
await page.click('.clinic:has-text("家醫內科一診")');
await page.waitForTimeout(300);
await page.fill('#num-input', '53');
await page.click('#num-save');
await page.waitForTimeout(300);
await page.click('#btn-add');
await page.waitForTimeout(300);
await page.click('.clinic:has-text("骨科二診")');
await page.waitForTimeout(300);
await page.click('#num-save');
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/test/pwa-main.png' });

await browser.close();
console.log(failed === 0 ? '\n全部通過 ✅' : `\n${failed} 項失敗 ❌`);
process.exit(failed === 0 ? 0 : 1);
