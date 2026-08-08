// 真實 Chromium 端對端測試：過期資料在各種路徑下都必須被清掉
// 端對端測試：在真的 Chromium 裡載入擴充功能，驗證過期資料一定會被清掉。
//
// 這組測試是因為 1.0.5／1.0.6 兩次「看起來合理但實際沒生效」的修正而寫的——
// 當時日期檢查被卡住的查詢擋在外面，靠讀程式碼推理完全看不出來。
//
// 執行：  node test/daily-reset.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXT_DIR, loadPlaywright, launchOptions, makeChecker, todayTaipei } from './_helpers.mjs';

const { chromium } = await loadPlaywright();
const { check, finish, state } = makeChecker();
const DIR = EXT_DIR;
const PROFILE = path.join(os.tmpdir(), '813-e2e-profile');
const TODAY = todayTaipei();

const staleWatch = {
  shift: '下午', section: '內分泌科', room: '內分泌科五診', doctor: '郭芝君',
  enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true,
  myNumber: 97, nearThreshold: 3
};

const mkStale = (extra = {}) => ({
  settings: { intervalMinutes: 1, paused: false, sound: true, requireInteraction: true, badgeEnabled: true, badgeKey: null },
  watches: [staleWatch],
  states: { __date: '20260804', '下午|內分泌科|內分泌科五診': { progress: '53', phase: 'open', missing: false } },
  snapshot: {
    fetchedAt: Date.now() - 4 * 86400000, date: '20260804', reason: 'alarm', error: null,
    rows: [{ SCD_VISITDT: '20260804', SHI_EASYNAME: '下午', SEC_SENAME: '內分泌科', EMP_EMPNAME: '郭芝君', ROM_RONAME: '內分泌科五診', CLC_MAXIMUM: '53', CLC_VISITNO_NOW: '53' }]
  },
  pollMode: 'idle',
  ...extra
});

const mkToday = () => ({
  settings: { intervalMinutes: 1, paused: false, sound: true, requireInteraction: true, badgeEnabled: true, badgeKey: null },
  watches: [{ ...staleWatch, room: '家醫內科一診', section: '家庭醫學科', myNumber: 35 }],
  states: { __date: TODAY, [`下午|家庭醫學科|家醫內科一診`]: { progress: '31', phase: 'open', missing: false } },
  snapshot: { fetchedAt: Date.now(), date: TODAY, reason: 'alarm', error: null, rows: [] },
  pollMode: 'active',
  day: TODAY,
  schemaVersion: 2
});

async function launch() {
  const ctx = await chromium.launchPersistentContext(
    PROFILE,
    launchOptions({
      serviceWorkers: 'allow',
      args: ['--no-sandbox', `--disable-extensions-except=${DIR}`, `--load-extension=${DIR}`]
    })
  );
  // 讓查詢快速失敗，測試環境連不到醫院網站；清除發生在抓取之前，不影響待測行為
  await ctx.route('**://www.813.com.tw/**', (r) => r.abort());
  return ctx;
}

async function waitSW(ctx) {
  for (let i = 0; i < 50; i++) {
    for (const w of ctx.serviceWorkers().slice().reverse()) {
      try { await w.evaluate(() => 1); return w; } catch (e) { /* 還沒好 */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('等不到 service worker');
}

const dump = (w) => w.evaluate(async () => {
  const s = await chrome.storage.local.get(null);
  return {
    day: s.day ?? null,
    schema: s.schemaVersion ?? null,
    watches: (s.watches || []).length,
    first: s.watches?.[0] ? `${s.watches[0].room}/號碼${s.watches[0].myNumber}` : null,
    stateKeys: Object.keys(s.states || {}).length,
    snapDate: s.snapshot?.date ?? null,
    reset: s.lastReset?.reason ?? null,
    settingsKept: !!s.settings && s.settings.intervalMinutes === 1
  };
});

const seed = (w, data) => w.evaluate(async (d) => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set(d);
}, data);

fs.rmSync(PROFILE, { recursive: true, force: true });

// ==================================================== 情境 1：使用中的背景服務
console.log('\n情境 1：擴充功能執行中，儲存裡是前幾天的資料（沒有 schemaVersion）');
let ctx = await launch();
let sw = await waitSW(ctx);
const extId = new URL(sw.url()).host;
await new Promise((r) => setTimeout(r, 2000));

await seed(sw, mkStale());
console.log('  灌入：', JSON.stringify(await dump(sw)));
let p = await ctx.newPage();
await p.goto(`chrome-extension://${extId}/popup.html`);
await new Promise((r) => setTimeout(r, 3000));
let a = await dump(sw);
console.log('  之後：', JSON.stringify(a));
check('監看清單（含號碼 97）被清空', a.watches === 0, a.first);
check('比對狀態被清空', a.stateKeys === 0, String(a.stateKeys));
check('前幾天的進度快取被清掉', a.snapDate === null, String(a.snapDate));
check('day 補成今天', a.day === TODAY, String(a.day));
check('通知設定保留', a.settingsKept);
await p.reload();
await p.waitForTimeout(1500);
check('popup 不再顯示過期診間卡片', (await p.locator('.item').count()) === 0);
check('popup 顯示空狀態', (await p.locator('.empty').count()) === 1);
await p.close();

// ==================================================== 情境 2：重開瀏覽器
console.log('\n情境 2：灌入過期資料後關掉瀏覽器，重開（等同重新載入擴充功能）');
await seed(sw, mkStale());
console.log('  灌入：', JSON.stringify(await dump(sw)));
await ctx.close();

ctx = await launch();
sw = await waitSW(ctx);
await new Promise((r) => setTimeout(r, 3000));
a = await dump(sw);
console.log('  重開後：', JSON.stringify(a));
check('重開後監看清單被清空', a.watches === 0, a.first);
check('重開後 day 為今天', a.day === TODAY, String(a.day));
check('有留下清除紀錄', !!a.reset, String(a.reset));

// ============================ 情境 3：已修復過，但資料日期是舊的（一般跨日）
console.log('\n情境 3：schemaVersion 已是最新，但資料日期是前幾天（一般的跨日情境）');
await seed(sw, mkStale({ schemaVersion: 2, day: '20260804' }));
console.log('  灌入：', JSON.stringify(await dump(sw)));
p = await ctx.newPage();
await p.goto(`chrome-extension://${extId}/popup.html`);
await new Promise((r) => setTimeout(r, 3000));
a = await dump(sw);
console.log('  之後：', JSON.stringify(a));
check('純靠日期判斷也清得掉', a.watches === 0, a.first);
check('day 更新為今天', a.day === TODAY, String(a.day));
await p.close();

// ============ 情境 4：1.0.5 的災情——day 被蓋成今天，但資料其實是舊的
console.log('\n情境 4：day 被舊版誤蓋成今天，但監看的仍是前幾天的診間');
await seed(sw, mkStale({ schemaVersion: 2, day: TODAY, states: { __date: '20260804' } }));
console.log('  灌入：', JSON.stringify(await dump(sw)));
p = await ctx.newPage();
await p.goto(`chrome-extension://${extId}/popup.html`);
await new Promise((r) => setTimeout(r, 3000));
a = await dump(sw);
console.log('  之後：', JSON.stringify(a));
check('以資料自己的日期為準，仍然清得掉', a.watches === 0, a.first);
await p.close();

// ==================================================== 情境 5：今天的資料不可被誤清
console.log('\n情境 5：今天的監看資料絕對不可以被清掉');
await seed(sw, mkToday());
console.log('  灌入：', JSON.stringify(await dump(sw)));
p = await ctx.newPage();
await p.goto(`chrome-extension://${extId}/popup.html`);
await new Promise((r) => setTimeout(r, 3000));
a = await dump(sw);
console.log('  之後：', JSON.stringify(a));
check('今天的監看清單完整保留', a.watches === 1, String(a.watches));
check('我的號碼保留', a.first && a.first.includes('35'), a.first);
check('popup 顯示該診間', (await p.locator('.item').count()) === 1);
await p.close();

await ctx.close();
finish();
