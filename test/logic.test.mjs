// 用假的 chrome API 實際載入 background.js，驗證通知與清除的判斷邏輯。
// 不需要瀏覽器，純 Node 就能跑：  node test/logic.test.mjs
import { EXT_DIR } from './_helpers.mjs';
const EXT = EXT_DIR;

let store = {};
let alarms = {};
let listeners = { alarm: [], message: [], storage: [], notifClick: [] };
let notifications = [];
let badge = { text: '', color: '', title: '' };
let sounds = [];
let nextData = [];
let fetchFails = false;
let fetchCalls = 0;
let fetchGate = null;

const clone = (o) => JSON.parse(JSON.stringify(o));

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (p) => 'chrome-extension://test/' + p,
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: (f) => listeners.message.push(f) },
    sendMessage: async (msg) => {
      if (msg.type === 'play-sound') sounds.push(msg.urgent ? 'urgent' : 'normal');
    },
    openOptionsPage: () => {}
  },
  storage: {
    local: {
      get: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (k in store) out[k] = clone(store[k]);
        return out;
      },
      set: async (obj) => {
        Object.assign(store, clone(obj));
        for (const f of listeners.storage) {
          f(Object.fromEntries(Object.keys(obj).map((k) => [k, {}])), 'local');
        }
      }
    },
    onChanged: { addListener: (f) => listeners.storage.push(f) }
  },
  alarms: {
    create: (name, info) => { alarms[name] = info; },
    clear: async (name) => { delete alarms[name]; return true; },
    get: async (name) => alarms[name] || undefined,
    onAlarm: { addListener: (f) => listeners.alarm.push(f) }
  },
  notifications: {
    create: (id, opts, cb) => { notifications.push({ id, ...opts }); cb && cb(id); },
    clear: async () => true,
    onClicked: { addListener: (f) => listeners.notifClick.push(f) }
  },
  action: {
    setBadgeText: async ({ text }) => { badge.text = text; },
    setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
    setTitle: async ({ title }) => { badge.title = title; }
  },
  offscreen: {
    hasDocument: async () => true,
    createDocument: async () => {}
  },
  tabs: { create: () => {} }
};

globalThis.fetch = async () => {
  fetchCalls++;
  if (fetchGate) await fetchGate;
  if (fetchFails) throw new Error('網路錯誤');
  const body = JSON.stringify(nextData);
  return { ok: true, status: 200, text: async () => body };
};

const ROOM = { shift: '下午', section: '內分泌科', room: '內分泌科一診', doctor: '王大明' };

const TDY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');

function data(progress, extra = {}) {
  return [
    {
      SCD_VISITDT: TDY,
      SHI_EASYNAME: ROOM.shift,
      SEC_SENAME: ROOM.section,
      EMP_EMPNAME: ROOM.doctor,
      ROM_RONAME: ROOM.room,
      CLC_MAXIMUM: progress,
      CLC_VISITNO_NOW: progress,
      ...extra
    },
    {
      SCD_VISITDT: TDY,
      SHI_EASYNAME: '上午',
      SEC_SENAME: '眼科',
      EMP_EMPNAME: '李醫師',
      ROM_RONAME: '眼科一診',
      CLC_MAXIMUM: '看診結束',
      CLC_VISITNO_NOW: '30'
    }
  ];
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

async function tick(progress) {
  nextData = data(progress);
  notifications = [];
  sounds = [];
  for (const f of listeners.alarm) f({ name: 'poll-clinic-progress' });
  await new Promise((r) => setTimeout(r, 250));
}

function titles() { return notifications.map((n) => n.title); }

async function poll_manual() {
  for (const f of listeners.message) {
    const r = f({ type: 'poll-now' }, {}, () => {});
    if (r === true) break;
  }
  await new Promise((r) => setTimeout(r, 300));
}

// ------------------------------------------------------------------ setup
store = {
  settings: { intervalMinutes: 0.5, paused: false, sound: true, requireInteraction: true, badgeEnabled: true, badgeKey: null },
  watches: [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }],
  states: {},
  schemaVersion: 2
};

const { todayInTaipei: todayTaipei, msUntilTaipeiMidnight } = await import(EXT + '/common.js');
store.day = todayTaipei();
store.states = { __date: todayTaipei() };
await import(EXT + '/background.js');
await new Promise((r) => setTimeout(r, 300));

console.log('\n情境 A：基本流程（我的號碼 50，剩 3 號提醒）');
await tick('40');
check('首次觀測不發通知（避免安裝當下洗版）', notifications.length === 0, titles().join(','));
check('badge 顯示目前號碼 40', badge.text === '40', badge.text);

await tick('41');
check('進度異動 → 1 則通知', notifications.length === 1, titles().join(','));
check('通知標題含 40 → 41', titles()[0].includes('40') && titles()[0].includes('41'), titles()[0]);
check('播放一般音效', sounds[0] === 'normal', sounds.join(','));

await tick('41');
check('進度沒變 → 不通知', notifications.length === 0, titles().join(','));

await tick('47');
check('剩 3 號 → 觸發「快輪到你了」', titles().some((t) => t.includes('快輪到你了') && t.includes('3')), titles().join(','));
check('只發 1 則（不重複發進度異動）', notifications.length === 1, titles().join(','));
check('播放急促音效', sounds[0] === 'urgent', sounds.join(','));
check('badge 轉為警示色', badge.color === '#ea580c', badge.color);

await tick('48');
check('剩 2 號 → 再次提醒', titles().some((t) => t.includes('還剩 2 位')), titles().join(','));

await tick('48');
check('同一個號碼不重複提醒', notifications.length === 0, titles().join(','));

await tick('50');
check('剩 0 → 「輪到你了」', titles().some((t) => t.includes('輪到你了')), titles().join(','));
check('badge 轉為紅色', badge.color === '#dc2626', badge.color);

await tick('51');
check('過號後安靜停止，不發「已經過號」通知', !titles().some((t) => t.includes('已經過號')) && store.watches[0].enabled === false, titles().join(','));

await tick('52');
check('停止後進度繼續變化也不通知', notifications.length === 0, titles().join(','));

await tick('看診結束');
check('過號後看診結束不再通知', !titles().some((t) => t.includes('看診結束')), titles().join(','));
check('過號停止後不再把此診間當成啟用監看', badge.text === '', badge.text);

console.log('\n情境 B：只開「進度異動就通知」，關掉快輪到我');
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: false, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
await tick('45');
await tick('48');
check('剩 2 號但未開啟近號提醒 → 只發進度異動通知', notifications.length === 1 && titles()[0].includes('45'), titles().join(','));

console.log('\n情境 C：只開「快輪到我」，關掉進度異動');
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: false, notifyNear: true, notifyStatus: false, myNumber: 50, nearThreshold: 3 }];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
await tick('30');
await tick('40');
check('離很遠時完全不吵', notifications.length === 0, titles().join(','));
await tick('49');
check('剩 1 號才通知', notifications.length === 1 && titles()[0].includes('還剩 1 位'), titles().join(','));

console.log('\n情境 D：沒填我的號碼，只要有異動就通知');
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: null, nearThreshold: 3 }];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
await tick('10');
await tick('11');
check('每次號碼變動都通知', notifications.length === 1, titles().join(','));

console.log('\n情境 E：開診 / 尚未開診 / 診間消失 / 換日 / 抓取失敗');
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
await tick('-');
await tick('5');
check('從「-」變成有號碼 → 開始看診通知', titles().some((t) => t.includes('開始看診')), titles().join(','));

nextData = data('5').filter((r) => r.ROM_RONAME !== ROOM.room);
notifications = [];
for (const f of listeners.alarm) f({ name: 'poll-clinic-progress' });
await new Promise((r) => setTimeout(r, 250));
check('診間從班表消失 → 不當機、不亂通知', notifications.length === 0, titles().join(','));
check('badge 顯示 –', badge.text === '–', badge.text);

// 換日
store.states = { ...store.states, __date: '20200101' };
await tick('3');
check('換日重置基準且不發通知', notifications.length === 0, titles().join(','));

fetchFails = true;
notifications = [];
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
store.states = { __date: todayTaipei() };
store.snapshot = { fetchedAt: Date.now(), date: todayTaipei(), rows: data('51') };
for (const f of listeners.alarm) f({ name: 'poll-clinic-progress' });
await new Promise((r) => setTimeout(r, 250));
check('抓取失敗不發通知、保留舊資料', notifications.length === 0 && store.snapshot.stale === true, JSON.stringify(store.snapshot?.error));
check('抓取失敗帶回的過號舊資料不會停用', store.watches[0].enabled === true, JSON.stringify(store.watches[0]));
fetchFails = false;

console.log('\n情境 F：多診間同時監看');
store.watches = [
  { ...ROOM, enabled: true, notifyOnChange: true, notifyNear: false, notifyStatus: false, myNumber: null, nearThreshold: 3 },
  { shift: '上午', section: '眼科', room: '眼科一診', doctor: '李醫師', enabled: true, notifyOnChange: true, notifyNear: false, notifyStatus: true, myNumber: null, nearThreshold: 3 }
];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
await tick('20');
nextData = [
  { ...data('21')[0] },
  { SCD_VISITDT: '20260804', SHI_EASYNAME: '上午', SEC_SENAME: '眼科', EMP_EMPNAME: '李醫師', ROM_RONAME: '眼科一診', CLC_MAXIMUM: '31', CLC_VISITNO_NOW: '31' }
];
notifications = [];
for (const f of listeners.alarm) f({ name: 'poll-clinic-progress' });
await new Promise((r) => setTimeout(r, 250));
check('兩個診間各自發出通知', notifications.length === 2, titles().join(' / '));
check('通知 ID 各自獨立（不會互相蓋掉）', new Set(notifications.map((n) => n.id)).size === 2, notifications.map((n) => n.id).join(','));

console.log('\n情境 G：通知選項');
check('requireInteraction 有帶入', notifications.every((n) => n.requireInteraction === true));
check('silent=true（改用擴充功能自己的音效）', notifications.every((n) => n.silent === true));

console.log('\n情境 H：alarm 設定');
check('輪詢週期為 0.5 分鐘', alarms['poll-clinic-progress']?.periodInMinutes === 0.5, JSON.stringify(alarms));

console.log('\n情境 I：看診結束後停止密集查詢');
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
store.pollMode = 'active';
await tick('40');
check('看診中維持原本的輪詢頻率', alarms['poll-clinic-progress']?.periodInMinutes === 0.5, JSON.stringify(alarms));
check('pollMode 為 active', store.pollMode === 'active', store.pollMode);

await tick('看診結束');
check('全部看診結束 → 切換為 idle', store.pollMode === 'idle', store.pollMode);
check('輪詢間隔放寬為 30 分鐘', alarms['poll-clinic-progress']?.periodInMinutes === 30, JSON.stringify(alarms));

notifications = [];
await tick('看診結束');
check('idle 期間不會重複發通知', notifications.length === 0, titles().join(','));
check('idle 期間維持 30 分鐘間隔', alarms['poll-clinic-progress']?.periodInMinutes === 30, JSON.stringify(alarms));

// 隔天班表出來，重新開診
store.states = { __date: '20200101' };
store.day = '20200101';
nextData = data('3').map(r => ({ ...r, SCD_VISITDT: '20200102' }));
notifications = [];
for (const f of listeners.alarm) f({ name: 'poll-clinic-progress' });
await new Promise((r) => setTimeout(r, 250));
check('隔天清除後監看清單為空，因此進入 idle', store.pollMode === 'idle' && store.watches.length === 0, store.pollMode);
// 重新加入監看後應該恢復正常頻率
await new Promise((r) => setTimeout(r, 1200)); // 等上一輪查詢完全結束，避免撞上去重
// 上一輪的資料日期是刻意造的舊日期，這裡回到今天的基準再測「重新加入監看」
store.states = {};
store.snapshot = null;
store.day = todayTaipei();
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
await tick('5');
await new Promise((r) => setTimeout(r, 400));
check('重新加入監看後回到 active', store.pollMode === 'active', store.pollMode);
check('輪詢頻率恢復為 0.5 分鐘', alarms['poll-clinic-progress']?.periodInMinutes === 0.5, JSON.stringify(alarms));

console.log('\n情境 J：多診間只有部分結束時不可停');
store.watches = [
  { ...ROOM, enabled: true, notifyOnChange: true, notifyNear: false, notifyStatus: false, myNumber: null, nearThreshold: 3 },
  { shift: '上午', section: '眼科', room: '眼科一診', doctor: '李醫師', enabled: true, notifyOnChange: true, notifyNear: false, notifyStatus: false, myNumber: null, nearThreshold: 3 }
];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
store.pollMode = 'active';
// 眼科一診固定是「看診結束」，內分泌科還在看診中
await tick('25');
check('只有一個診結束時仍維持密集查詢', store.pollMode === 'active' && alarms['poll-clinic-progress']?.periodInMinutes === 0.5, store.pollMode);
await tick('看診結束');
check('兩個診都結束才切換為 idle', store.pollMode === 'idle', store.pollMode);

console.log('\n情境 K：尚未開診不可誤判為結束');
store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
store.pollMode = 'active';
await tick('-');
check('診間顯示「-」（尚未開診）時不會停止查詢', store.pollMode === 'active' && alarms['poll-clinic-progress']?.periodInMinutes === 0.5, store.pollMode);

console.log('\n情境 K2：狀態不同步時自我修正');
store.pollMode = 'idle';           // 模式說 idle，但實際上診間還在看診
alarms['poll-clinic-progress'] = { periodInMinutes: 30 };
await tick('12');
check('偵測到不該 idle → 自動修回 0.5 分鐘', alarms['poll-clinic-progress']?.periodInMinutes === 0.5, JSON.stringify(alarms));
check('pollMode 一併修正為 active', store.pollMode === 'active', store.pollMode);

console.log('\n情境 L：手動重新查詢在 idle 期間仍可用');
store.pollMode = 'idle';
nextData = data('看診結束');
notifications = [];
await poll_manual();
check('idle 期間手動查詢仍會抓資料', store.snapshot && store.snapshot.reason === 'manual', JSON.stringify(store.snapshot?.reason));

console.log('\n情境 M：每天凌晨清除前一天的紀錄');
{
  // 有監看、有狀態、有快照，日期停留在前幾天
  store.settings = { ...store.settings, dailyReset: true };
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
  store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
  store.pollMode = 'active';
  await tick('40');
  // 讓資料自己帶的日期是幾天前（新的判斷以資料日期為準）
  store.day = '20260801';
  store.states = { ...store.states, __date: '20260801' };
  const beforeWatches = store.watches.length;
  notifications = [];
  await tick('40');
  check('清除前確實有監看中的診間', beforeWatches === 1);
  check('跨日後監看清單被清空', store.watches.length === 0, JSON.stringify(store.watches));
  check('跨日後比對狀態被清空', !store.states || Object.keys(store.states).filter(k => k !== '__date').length === 0, JSON.stringify(store.states));
  check('日期更新為今天', store.day === todayTaipei(), store.day);
  check('清除時不會發通知', notifications.length === 0, titles().join(','));
  check('通知與更新設定保留', store.settings.intervalMinutes === 0.5 && store.settings.sound === true);
  check('有留下清除紀錄', store.lastReset && store.lastReset.day === todayTaipei(), JSON.stringify(store.lastReset));
  check('已排定下一次凌晨清除', !!alarms['daily-reset'], JSON.stringify(Object.keys(alarms)));
}

console.log('\n情境 M2：從舊版升級（儲存資料沒有 day 欄位）');
{
  // 重現使用者遇到的情況：v1.0.4 留下的資料只有 states.__date，沒有 day
  store.settings = { ...store.settings, dailyReset: true };
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 97, nearThreshold: 3 }];
  store.states = { __date: '20260804', '下午|內分泌科|內分泌科一診': { progress: '46', phase: 'open' } };
  store.snapshot = { fetchedAt: Date.now() - 3 * 86400000, date: '20260804', rows: [] };
  delete store.day;            // 舊版沒有這個欄位
  delete store.schemaVersion;  // 也沒有 schemaVersion
  notifications = [];
  await tick('40');
  check('沒有 day 欄位時改用 states.__date 判斷', store.watches.length === 0, JSON.stringify(store.watches));
  check('過期的我的號碼被清掉', !store.watches.some(w => w.myNumber === 97));
  check('補上 day 欄位', store.day === todayTaipei(), String(store.day));
  check('升級清除時不發通知', notifications.length === 0, titles().join(','));
}

console.log('\n情境 M3：只有 snapshot 帶日期時也判斷得出來');
{
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 97, nearThreshold: 3 }];
  store.schemaVersion = 2;
  store.states = {};                 // 沒有比對基準
  store.snapshot = { fetchedAt: Date.now() - 86400000, date: '20260801', rows: [] };
  delete store.day;
  await tick('40');
  check('退回用 snapshot.date 判斷並清除', store.watches.length === 0, JSON.stringify(store.watches));
}

console.log('\n情境 M4：有監看但完全沒有日期線索 → 保守清除');
{
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 97, nearThreshold: 3 }];
  store.schemaVersion = 2;
  store.states = {};                 // 完全沒有日期線索
  delete store.snapshot;
  delete store.day;
  await tick('40');
  check('來源不明的監看資料一律清掉', store.watches.length === 0, JSON.stringify(store.watches));
}

console.log('\n情境 M5：全新安裝不可誤清');
{
  store.watches = [];
  store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
  delete store.snapshot;
  delete store.day;
  await tick('40');
  check('空儲存時只記下日期', store.day === todayTaipei(), String(store.day));
  // 全新安裝後使用者馬上加入監看，同一天內不可被清掉
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
  await tick('41');
  check('剛加入的監看不會被誤清', store.watches.length === 1, JSON.stringify(store.watches));
}

console.log('\n情境 N：關閉自動清除時只重置比對基準');
{
  store.settings = { ...store.settings, dailyReset: false };
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
  store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
  store.day = todayTaipei();
  await tick('40');
  store.day = '20260801';
  store.states = { ...store.states, __date: '20260801' };
  notifications = [];
  await tick('44');
  check('監看清單保留', store.watches.length === 1, JSON.stringify(store.watches));
  check('比對基準已重置，不會因跨日誤發通知', notifications.length === 0, titles().join(','));
  check('日期仍更新為今天', store.day === todayTaipei(), store.day);
  store.settings = { ...store.settings, dailyReset: true };
}

console.log('\n情境 O：同一天不會誤清');
{
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
  store.states = { __date: todayTaipei() }; store.schemaVersion = 2; store.day = todayTaipei();
  store.day = todayTaipei();
  await tick('40');
  await tick('41');
  check('同一天內監看清單不受影響', store.watches.length === 1);
  check('同一天內進度異動照常通知', notifications.length === 1, titles().join(','));
}

console.log('\n情境 P：台北午夜倒數計算');
{
  const at = (iso) => msUntilTaipeiMidnight(new Date(iso));
  // UTC 16:00 = 台北隔天 00:00 → 應該剛好是一整天（+5 秒緩衝）
  check('台北 00:00 時回傳約 24 小時', Math.abs(at('2026-08-04T16:00:00Z') - (86400000 + 5000)) < 1500, String(at('2026-08-04T16:00:00Z')));
  // UTC 15:00 = 台北 23:00 → 剩 1 小時
  check('台北 23:00 時剩約 1 小時', Math.abs(at('2026-08-04T15:00:00Z') - (3600000 + 5000)) < 1500, String(at('2026-08-04T15:00:00Z')));
  // UTC 04:00 = 台北 12:00 → 剩 12 小時
  check('台北 12:00 時剩約 12 小時', Math.abs(at('2026-08-04T04:00:00Z') - (12 * 3600000 + 5000)) < 1500, String(at('2026-08-04T04:00:00Z')));
  check('永遠為正數（不會排到過去）', at('2026-08-04T15:59:59Z') > 0 && at('2026-08-04T16:00:01Z') > 0);
}

console.log('\n情境 Q：我的號碼已過就停止監看');
{
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: false, notifyNear: false, notifyStatus: false, myNumber: 50, nearThreshold: 3 }];
  store.states = { __date: todayTaipei() }; store.day = todayTaipei(); store.schemaVersion = 2;
  notifications = [];
  await tick('51');
  check('首次看到已過號也會停止監看', store.watches[0].enabled === false, JSON.stringify(store.watches[0]));
  check('首次看到已過號依既有首次觀測政策保持靜默', notifications.length === 0, titles().join(','));

  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: true, notifyNear: true, notifyStatus: true, myNumber: 53, nearThreshold: 3 }];
  store.states = { __date: todayTaipei() }; store.day = todayTaipei();
  await tick('52');
  await tick('82');
  check('號碼 53 遇到 52 → 82 時安靜停用', store.watches[0].enabled === false && notifications.length === 0, `${JSON.stringify(store.watches[0])} ${titles().join(',')}`);
  check('靜默停用保留號碼與提醒設定', store.watches[0].myNumber === 53 && store.watches[0].notifyNear && store.watches[0].notifyStatus, JSON.stringify(store.watches[0]));
  check('停用後自動診間輪詢 alarm 已清除，日清 alarm 保留', alarms['poll-clinic-progress'] === undefined && !!alarms['daily-reset'], JSON.stringify(alarms));

  notifications = [];
  nextData = data('52');
  const callsBeforeAutomaticTick = fetchCalls;
  await tick('52');
  check('停用後自動輪詢事件不再打網路', fetchCalls === callsBeforeAutomaticTick && store.snapshot.rows[0].CLC_MAXIMUM === '82', String(fetchCalls));
  await poll_manual();
  check('停用後手動更新仍可抓資料但不再通知', notifications.length === 0 && store.snapshot.rows[0].CLC_MAXIMUM === '52', titles().join(','));
  nextData = data('49');
  await poll_manual();
  check('進度回退不會重新啟用或通知', store.watches[0].enabled === false && notifications.length === 0, JSON.stringify(store.watches[0]));
  nextData = data('看診結束');
  await poll_manual();
  check('停用後看診結束不再通知', notifications.length === 0, titles().join(','));
}

console.log('\n情境 Q2：沒有有效叫號資料時不停止監看');
{
  const quietWatch = { ...ROOM, enabled: true, notifyOnChange: false, notifyNear: false, notifyStatus: false, myNumber: 50, nearThreshold: 3 };
  store.watches = [{ ...quietWatch }];
  store.states = { __date: todayTaipei() };
  await tick('進度更新中');
  check('非數字進度不會停用', store.watches[0].enabled === true, JSON.stringify(store.watches[0]));

  store.watches = [{ ...quietWatch, myNumber: null }];
  store.states = { __date: todayTaipei() };
  await tick('61');
  check('未設定我的號碼不會停用', store.watches[0].enabled === true, JSON.stringify(store.watches[0]));

  store.watches = [{ ...quietWatch }];
  store.states = { __date: todayTaipei() };
  await tick('看診結束');
  check('看診結束狀態不會被當成過號停用', store.watches[0].enabled === true, JSON.stringify(store.watches[0]));

  store.watches = [{ ...quietWatch }];
  store.states = { __date: todayTaipei() };
  nextData = data('61').filter((row) => row.ROM_RONAME !== ROOM.room);
  notifications = [];
  for (const listener of listeners.alarm) listener({ name: 'poll-clinic-progress' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('診間缺少時不會停用', store.watches[0].enabled === true, JSON.stringify(store.watches[0]));
}

console.log('\n情境 R：抓取期間更改我的號碼不覆蓋新設定');
{
  store.watches = [{ ...ROOM, enabled: true, notifyOnChange: false, notifyNear: true, notifyStatus: true, myNumber: 50, nearThreshold: 3 }];
  store.states = { __date: todayTaipei() };
  await tick('49');

  let releaseFetch;
  fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  nextData = data('51');
  const pending = poll_manual();
  await new Promise((r) => setTimeout(r, 20));
  store.watches = [{ ...store.watches[0], myNumber: 52, enabled: true, notifyNear: false }];
  releaseFetch();
  fetchGate = null;
  await pending;
  check('只依舊號碼判斷，不把新號碼設定停用', store.watches[0].enabled === true && store.watches[0].myNumber === 52, JSON.stringify(store.watches[0]));
  check('新設定的其他欄位也保留', store.watches[0].notifyNear === false, JSON.stringify(store.watches[0]));
}

console.log(failed === 0 ? '\n全部通過 ✅' : `\n${failed} 項失敗 ❌`);
process.exit(failed === 0 ? 0 : 1);
