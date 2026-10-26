// 用假的 KV 與 fetch，實際跑 Worker 的路由與排程邏輯
import { pollAndPush, dailyReset } from '../worker/src/index.js';
import { evaluate, todayInTaipei, groupRows } from '../public/logic.js';

let failed = 0;
const check = (n, c, d) => {
  if (c) console.log('  ✓ ' + n);
  else {
    failed++;
    console.log('  ✗ ' + n + (d ? '  → ' + d : ''));
  }
};

// ------------------------------------------------------------ 假的 KV
function makeKV() {
  const m = new Map();
  return {
    _map: m,
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    }
  };
}

const TODAY = todayInTaipei();
const ROOM = { shift: '下午', section: '家庭醫學科', room: '家醫內科一診', doctor: '陳志豪' };

function rows(progress) {
  return [
    {
      SCD_VISITDT: TODAY,
      SHI_EASYNAME: ROOM.shift,
      SEC_SENAME: ROOM.section,
      EMP_EMPNAME: ROOM.doctor,
      ROM_RONAME: ROOM.room,
      CLC_MAXIMUM: progress,
      CLC_VISITNO_NOW: progress
    },
    {
      SCD_VISITDT: TODAY,
      SHI_EASYNAME: '上午',
      SEC_SENAME: '眼科',
      EMP_EMPNAME: '李美玲',
      ROM_RONAME: '眼科一診',
      CLC_MAXIMUM: '看診結束',
      CLC_VISITNO_NOW: '30'
    }
  ];
}

let currentProgress = '50';
let hospitalHits = 0;
let pushes = [];
let hospitalFetchGate = null;
let onHospitalFetchStarted = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('813.com.tw')) {
    hospitalHits++;
    onHospitalFetchStarted?.();
    if (hospitalFetchGate) await hospitalFetchGate;
    return { ok: true, status: 200, text: async () => JSON.stringify(rows(currentProgress)) };
  }
  // 推播端點
  pushes.push(u);
  return { ok: true, status: 201 };
};

function makeEnv(kv) {
  return {
    STATE: kv,
    VAPID_PUBLIC_KEY: null, // 先不啟用推播，專測狀態機
    VAPID_PRIVATE_KEY: null
  };
}

function makeSub(kv, watches, day = TODAY) {
  const rec = {
    id: 'abc',
    endpoint: 'https://push.example.com/x',
    keys: { p256dh: 'x', auth: 'y' },
    watches,
    states: {},
    prefs: {},
    day,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  kv._map.set('sub:abc', JSON.stringify(rec));
  return rec;
}

const WATCH = { ...ROOM, enabled: true, notifyNear: true, notifyOnChange: false, notifyStatus: true, myNumber: 60, nearThreshold: 3 };

// ------------------------------------------------------------ 測試
console.log('\n每分鐘排程：沒有訂閱時不打醫院網站');
{
  const kv = makeKV();
  hospitalHits = 0;
  const r = await pollAndPush(makeEnv(kv));
  check('回報無訂閱', r.skipped === '無訂閱', JSON.stringify(r));
  check('完全沒有對外請求', hospitalHits === 0, String(hospitalHits));
}

console.log('\n每分鐘排程：有訂閱但沒有啟用中的監看');
{
  const kv = makeKV();
  makeSub(kv, [{ ...WATCH, enabled: false }]);
  hospitalHits = 0;
  const r = await pollAndPush(makeEnv(kv));
  check('跳過查詢', r.skipped === '無啟用中的監看', JSON.stringify(r));
  check('沒有對外請求', hospitalHits === 0, String(hospitalHits));
}

console.log('\n每分鐘排程：快取避免同分鐘重複查詢');
{
  const kv = makeKV();
  makeSub(kv, [WATCH]);
  hospitalHits = 0;
  currentProgress = '50';
  await pollAndPush(makeEnv(kv));
  await pollAndPush(makeEnv(kv));
  await pollAndPush(makeEnv(kv));
  check('三次排程只打醫院一次（45 秒快取）', hospitalHits === 1, String(hospitalHits));
}

console.log('\n每分鐘排程：狀態有正確寫回 KV');
{
  const kv = makeKV();
  makeSub(kv, [WATCH]);
  currentProgress = '50';
  await pollAndPush(makeEnv(kv));
  const rec = JSON.parse(kv._map.get('sub:abc'));
  check('已記錄比對基準', rec.states['下午|家庭醫學科|家醫內科一診']?.progress === '50', JSON.stringify(rec.states));
  check('已記錄當日日期', rec.states.__date === TODAY);
}

console.log('\nWorker：過號後寫回停用狀態');
{
  const kv = makeKV();
  makeSub(kv, [WATCH]);
  currentProgress = '61';
  await pollAndPush(makeEnv(kv));
  let rec = JSON.parse(kv._map.get('sub:abc'));
  check('首次觀測已過號後將 enabled:false 寫回 KV', rec.watches[0].enabled === false, JSON.stringify(rec.watches));
  check('首次觀測靜默停止仍有保存進度基準', rec.states[`${ROOM.shift}|${ROOM.section}|${ROOM.room}`]?.progress === '61', JSON.stringify(rec.states));

  // 轉態路徑會有一次過號事件；沒有 VAPID 設定時只驗證持久化。
  const kv2 = makeKV();
  const sub = makeSub(kv2, [WATCH]);
  sub.states = evaluate([WATCH], rows('60'), {}).states;
  await kv2.put('sub:abc', JSON.stringify(sub));
  currentProgress = '61';
  await pollAndPush(makeEnv(kv2));
  rec = JSON.parse(kv2._map.get('sub:abc'));
  check('越過號碼的轉態也將 enabled:false 寫回 KV', rec.watches[0].enabled === false, JSON.stringify(rec.watches));
  check('停用紀錄保留我的號碼', rec.watches[0].myNumber === 60, JSON.stringify(rec.watches[0]));
}

console.log('\nWorker：抓取期間採用最新的訂閱設定');
{
  const kv = makeKV();
  const sub = makeSub(kv, [WATCH]);
  sub.states = evaluate([WATCH], rows('50'), {}).states;
  await kv.put('sub:abc', JSON.stringify(sub));

  let releaseFetch;
  const started = new Promise((resolve) => { onHospitalFetchStarted = resolve; });
  hospitalFetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  currentProgress = '61';
  const pending = pollAndPush(makeEnv(kv));
  await started;

  const latest = await kv.get('sub:abc', 'json');
  latest.watches = [{ ...WATCH, myNumber: 70, nearThreshold: 8, notifyNear: false, notifyOnChange: true, notifyStatus: false }];
  latest.prefs = { ...latest.prefs, clientRevision: 'updated-during-fetch' };
  await kv.put('sub:abc', JSON.stringify(latest));
  releaseFetch();
  hospitalFetchGate = null;
  onHospitalFetchStarted = null;
  await pending;

  const rec = await kv.get('sub:abc', 'json');
  check('舊的號碼 60 不會停用新的號碼 70', rec.watches[0].enabled === true && rec.watches[0].myNumber === 70, JSON.stringify(rec.watches));
  check('新提醒設定與訂閱欄位都保留', rec.watches[0].notifyNear === false && rec.watches[0].nearThreshold === 8 && rec.prefs.clientRevision === 'updated-during-fetch', JSON.stringify(rec));
  check('用最新設定評估後仍保存當前進度', rec.states[`${ROOM.shift}|${ROOM.section}|${ROOM.room}`]?.progress === '61', JSON.stringify(rec.states));

  const deletedKV = makeKV();
  makeSub(deletedKV, [WATCH]);
  let releaseDeletedFetch;
  const deletedFetchStarted = new Promise((resolve) => { onHospitalFetchStarted = resolve; });
  hospitalFetchGate = new Promise((resolve) => { releaseDeletedFetch = resolve; });
  const deletedPending = pollAndPush(makeEnv(deletedKV));
  await deletedFetchStarted;
  await deletedKV.delete('sub:abc');
  releaseDeletedFetch();
  hospitalFetchGate = null;
  onHospitalFetchStarted = null;
  await deletedPending;
  check('抓取期間被刪除的訂閱不會由舊快照寫回', !deletedKV._map.has('sub:abc'));
}

console.log('\n每分鐘排程：跨日時自動重置（半夜排程沒跑到的防呆）');
{
  const kv = makeKV();
  makeSub(kv, [WATCH], '20200101'); // 舊的一天
  await pollAndPush(makeEnv(kv));
  const rec = JSON.parse(kv._map.get('sub:abc'));
  check('監看清單被清空', rec.watches.length === 0, JSON.stringify(rec.watches));
  check('比對狀態被清空', Object.keys(rec.states).length === 0);
  check('日期更新為今天', rec.day === TODAY);
  check('推播訂閱本身保留', rec.endpoint === 'https://push.example.com/x' && !!rec.keys.p256dh);
}

console.log('\n凌晨 00:00 排程：清除前一天的紀錄');
{
  const kv = makeKV();
  makeSub(kv, [WATCH]);
  currentProgress = '55';
  await pollAndPush(makeEnv(kv)); // 先產生一些狀態
  kv._map.set('snapshot', JSON.stringify({ fetchedAt: Date.now(), date: TODAY, rows: rows('55') }));
  const before = JSON.parse(kv._map.get('sub:abc'));
  check('清除前確實有監看與狀態', before.watches.length === 1 && Object.keys(before.states).length > 0);

  const r = await dailyReset(makeEnv(kv));
  const after = JSON.parse(kv._map.get('sub:abc'));
  check('回報已清除 1 筆訂閱', r.cleared === 1, JSON.stringify(r));
  check('監看清單（含我的號碼）已清空', after.watches.length === 0, JSON.stringify(after.watches));
  check('比對狀態已清空', Object.keys(after.states).length === 0, JSON.stringify(after.states));
  check('當日進度快取已刪除', !kv._map.has('snapshot'));
  check('推播訂閱保留（隔天不用重新授權）', after.endpoint === 'https://push.example.com/x');
  check('偏好設定保留', after.prefs !== undefined);
  check('有留下清除紀錄供查核', JSON.parse(kv._map.get('lastReset')).cleared === 1);
}

console.log('\n凌晨排程：沒有任何訂閱時也不會出錯');
{
  const kv = makeKV();
  const r = await dailyReset(makeEnv(kv));
  check('正常結束，清除 0 筆', r.cleared === 0, JSON.stringify(r));
}

console.log('\n共用判斷邏輯（與擴充功能一致）');
{
  let st = {};
  let w = [WATCH];
  let out = evaluate(w, rows('50'), st);
  st = out.states;
  check('回傳更新後的監看清單', Array.isArray(out.watches), JSON.stringify(out));
  w = out.watches || w;
  check('首次觀測不通知', out.events.length === 0);

  out = evaluate(w, rows('57'), st);
  st = out.states;
  w = out.watches || w;
  check('剩 3 號 → 快輪到你了', out.events[0]?.title.includes('還剩 3 位'), JSON.stringify(out.events));

  out = evaluate(w, rows('57'), st);
  st = out.states;
  w = out.watches || w;
  check('同號碼不重複通知', out.events.length === 0);

  out = evaluate(w, rows('60'), st);
  st = out.states;
  w = out.watches || w;
  check('輪到你了', out.events[0]?.title.includes('輪到你了'));
  check('相等號碼仍保持啟用', w[0]?.enabled === true, JSON.stringify(w));

  out = evaluate(w, rows('61'), st);
  st = out.states;
  w = out.watches || w;
  check('超過號碼時安靜停用監看', out.events.length === 0 && w[0].enabled === false, JSON.stringify({ events: out.events, watches: w }));
  check('停用監看後 allDone 為 true', out.allDone === true, String(out.allDone));
  out = evaluate(w, rows('59'), st);
  st = out.states;
  w = out.watches || w;
  check('停用後進度回退也不再通知或恢復', out.events.length === 0 && w[0].enabled === false, JSON.stringify({ events: out.events, watches: w }));

  out = evaluate(w, rows('看診結束'), st);
  check('停止監看後看診結束不再通知，allDone 為 true', out.events.length === 0 && out.allDone === true);

  // 尚未開診不可被當成結束
  const out2 = evaluate([WATCH], rows('-'), {});
  check('啟用監看尚未開診時 allDone 為 false', out2.allDone === false);
  const out3 = evaluate(w, rows('-'), {});
  check('已停用監看後尚未開診仍保持 allDone', out3.allDone === true);
}

console.log('\n過號停用邊界');
{
  const jumpWatch = { ...WATCH, myNumber: 53, notifyNear: false, notifyOnChange: true, notifyStatus: true };
  const jumpKey = `${ROOM.shift}|${ROOM.section}|${ROOM.room}`;
  const beforeJump = {
    __date: TODAY,
    [jumpKey]: { progress: '52', phase: 'open', missing: false, notifiedPassed: false }
  };
  const jump = evaluate([jumpWatch], rows('82'), beforeJump);
  check('號碼 53 遇到進度 52 → 82 時靜默停用', jump.events.length === 0 && jump.watches[0].enabled === false, JSON.stringify(jump));
  const phaseChange = evaluate([jumpWatch], rows('82'), {
    __date: TODAY,
    [jumpKey]: { progress: '-', phase: 'idle', missing: false, notifiedPassed: false }
  });
  check('跨號時狀態轉換也不發通知', phaseChange.events.length === 0 && phaseChange.watches[0].enabled === false, JSON.stringify(phaseChange));

  const passedWatch = { ...WATCH, myNumber: 60, notifyNear: false, notifyOnChange: false, notifyStatus: false };
  let out = evaluate([passedWatch], rows('61'), {});
  let returned = out.watches || [passedWatch];
  check('初次觀測已過號時靜默停用', out.events.length === 0 && returned[0].enabled === false, JSON.stringify(out));
  check('初次停用保留監看設定', returned[0].myNumber === 60 && returned[0].notifyNear === false, JSON.stringify(returned[0]));

  let states = {};
  let watches = [passedWatch];
  out = evaluate(watches, rows('60'), states);
  states = out.states;
  watches = out.watches || watches;
  out = evaluate(watches, rows('61'), states);
  check('通知選項全關仍會因過號停用', out.events.length === 0 && out.watches?.[0]?.enabled === false, JSON.stringify(out));

  const untouched = { ...WATCH, myNumber: 60 };
  for (const progress of ['-', '進度更新中', '看診結束']) {
    const r = evaluate([untouched], rows(progress), {});
    check(`${progress} 不會因非數字/結束狀態而停用`, (r.watches || [untouched])[0].enabled === true, JSON.stringify(r.watches));
  }
  const missing = evaluate([untouched], rows('61').filter((r) => r.ROM_RONAME !== ROOM.room), {});
  check('缺少診間資料時不會停用', (missing.watches || [untouched])[0].enabled === true, JSON.stringify(missing.watches));

  for (const myNumber of [null, NaN, Infinity, 'no-number']) {
    const noFiniteNumber = { ...WATCH, myNumber };
    const r = evaluate([noFiniteNumber], rows('61'), {});
    check(`號碼 ${String(myNumber)} 不是有限數字時不會停用`, (r.watches || [noFiniteNumber])[0].enabled === true, JSON.stringify(r.watches));
  }

  const other = { ...WATCH, shift: '上午', section: '眼科', room: '眼科一診', doctor: '李美玲', myNumber: 100 };
  const mixed = evaluate([passedWatch, other], rows('61'), {});
  check('多診間只停用超過號碼的那一筆', mixed.watches?.[0]?.enabled === false && mixed.watches?.[1]?.enabled === true, JSON.stringify(mixed.watches));
}

console.log('\n時區處理');
{
  // 台北 00:30 → 當天；UTC 同時刻是前一天 16:30
  const d = new Date('2026-08-04T16:30:00Z'); // = 台北 2026-08-05 00:30
  check('UTC 16:30 對應台北隔天', todayInTaipei(d) === '20260805', todayInTaipei(d));
  const d2 = new Date('2026-08-04T15:30:00Z'); // = 台北 2026-08-04 23:30
  check('UTC 15:30 仍是台北當天', todayInTaipei(d2) === '20260804', todayInTaipei(d2));
  check('格式為 YYYYMMDD', /^\d{8}$/.test(todayInTaipei()));
}

console.log('\n診間分組');
{
  const g = groupRows(rows('50'));
  check('依時段分組並排序（上午在前）', g[0].shift === '上午' && g[1].shift === '下午', JSON.stringify(g.map((x) => x.shift)));
}

console.log(failed === 0 ? '\n全部通過 ✅' : `\n${failed} 項失敗 ❌`);
process.exit(failed === 0 ? 0 : 1);
