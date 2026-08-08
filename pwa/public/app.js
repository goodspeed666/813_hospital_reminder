import {
  evaluate,
  groupRows,
  phaseOf,
  progressNum,
  progressText,
  rowKey,
  todayInTaipei,
  watchKey,
  DEFAULT_WATCH,
  PAGE_URL
} from './logic.js';

// ---------------------------------------------------------------- 設定
// 部署後把這裡換成你的 Worker 網址；也可用 ?api=https://... 覆寫（會記住）
const DEFAULT_API = 'https://813-reminder.YOUR-SUBDOMAIN.workers.dev';
const STORE_KEY = '813pwa.v1';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

let state = {
  api: DEFAULT_API,
  day: todayInTaipei(),
  watches: [],
  states: {},
  prefs: { notify: true, push: false, wakeLock: true, sound: true },
  snapshot: null
};

let rows = [];
let shiftFilter = '全部';
let keyword = '';
let editingKey = null;
let timer = null;
let wakeLock = null;
let midnightTimer = null;
let audioCtx = null;
let pushConfig = { pushEnabled: false, vapidPublicKey: null };

// ---------------------------------------------------------------- 儲存

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) {
    /* 壞掉就用預設值 */
  }
  const api = params.get('api');
  if (api) state.api = api.replace(/\/+$/, '');
  if (!state.prefs) state.prefs = { notify: true, push: false, wakeLock: true, sound: true };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    /* 私密瀏覽等情況可能無法寫入 */
  }
}

/**
 * 跨日清除：每天台北時間 00:00 之後第一次執行到這裡，
 * 就把前一天的監看清單（含我的號碼）、比對狀態與進度快取清掉。
 */
function clearIfNewDay(silent = false) {
  const today = todayInTaipei();
  if (state.day === today) return false;
  state.day = today;
  state.watches = [];
  state.states = {};
  state.snapshot = null;
  save();
  if (!silent) toast('已清除前一天的看診紀錄');
  return true;
}

async function clearToday() {
  state.watches = [];
  state.states = {};
  state.snapshot = null;
  save();
  syncToServer();
  render();
  toast('已清除今日紀錄');
  await tick(true); // 立刻重新查一次，狀態列才不會停在「尚未查詢」
}

/** App 一直開著時，排一個剛好在台北午夜觸發的計時器 */
function scheduleMidnight() {
  clearTimeout(midnightTimer);
  const now = new Date();
  const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const next = new Date(taipeiNow);
  next.setHours(24, 0, 5, 0); // 午夜過 5 秒，避開邊界
  const ms = Math.max(1000, next - taipeiNow);
  midnightTimer = setTimeout(() => {
    clearIfNewDay();
    render();
    scheduleMidnight();
  }, Math.min(ms, 2 ** 31 - 1));
}

// ---------------------------------------------------------------- 資料

async function fetchProgress(force = false) {
  const url = state.api + '/api/progress' + (force ? '?force=1' : '');
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  if (!data.rows) throw new Error(data.error || '查詢失敗');
  return data;
}

async function tick(force = false) {
  clearIfNewDay();
  try {
    const snap = await fetchProgress(force);
    rows = snap.rows;
    state.snapshot = { fetchedAt: snap.fetchedAt, date: snap.date, error: snap.error || null };

    if (state.watches.length) {
      const out = evaluate(state.watches, rows, state.states);
      state.states = out.states;
      if (state.prefs.notify) for (const ev of out.events) await showNotification(ev);
      if (out.events.length && state.prefs.sound) beep(out.events.some((e) => e.urgent));
    }
    save();
  } catch (e) {
    state.snapshot = { ...(state.snapshot || {}), error: String(e.message || e) };
  }
  render();
}

function startLoop() {
  clearInterval(timer);
  timer = setInterval(() => tick(), 30000);
}

// ---------------------------------------------------------------- 通知

async function showNotification(ev) {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || Notification.permission !== 'granted') return;
  reg.showNotification(ev.title, {
    body: ev.body,
    tag: ev.key || 'clinic',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    vibrate: state.prefs.sound ? (ev.urgent ? [220, 90, 220, 90, 320] : [140, 80, 140]) : undefined,
    requireInteraction: !!ev.urgent,
    data: { url: PAGE_URL }
  });
}

function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch (e) {
    /* 不支援就算了 */
  }
}

function beep(urgent) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t0 = audioCtx.currentTime + 0.02;
  const tone = (f, at, dur, g) => {
    const o = audioCtx.createOscillator();
    const gn = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    gn.gain.setValueAtTime(0, at);
    gn.gain.linearRampToValueAtTime(g, at + 0.02);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(gn).connect(audioCtx.destination);
    o.start(at);
    o.stop(at + dur + 0.05);
  };
  if (urgent) {
    tone(988, t0, 0.16, 0.3);
    tone(988, t0 + 0.22, 0.16, 0.3);
    tone(1319, t0 + 0.44, 0.28, 0.32);
  } else {
    tone(660, t0, 0.14, 0.2);
    tone(880, t0 + 0.18, 0.2, 0.2);
  }
}

async function ensureNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

// ---------------------------------------------------------------- 螢幕不休眠

async function updateWakeLock() {
  const want = state.prefs.wakeLock && state.watches.some((w) => w.enabled !== false);
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch (e) {
      /* 電量低或不支援時會失敗，忽略 */
    }
  } else if (!want && wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      /* ignore */
    }
    wakeLock = null;
  }
}

// ---------------------------------------------------------------- 背景推播

function b64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function enablePush() {
  if (!pushConfig.pushEnabled) {
    toast('伺服器尚未設定推播金鑰');
    return false;
  }
  if (!(await ensureNotifyPermission())) {
    toast('通知權限被拒絕，請到系統設定開啟');
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(pushConfig.vapidPublicKey)
    });
  }
  await syncToServer(sub);
  return true;
}

async function disablePush() {
  const sub = await getSubscription();
  if (!sub) return;
  await fetch(state.api + '/api/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint })
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** 把監看清單同步到 Worker，讓它在 App 關著時也能推播 */
async function syncToServer(subOverride) {
  if (!state.prefs.push) return;
  const sub = subOverride || (await getSubscription());
  if (!sub) return;
  const j = sub.toJSON ? sub.toJSON() : sub;
  await fetch(state.api + '/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: { endpoint: j.endpoint, keys: j.keys },
      watches: state.watches,
      prefs: state.prefs
    })
  }).catch(() => {});
}

// ---------------------------------------------------------------- 畫面

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), ms);
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render() {
  const day = state.day;
  $('#day-tag').textContent = `${day.slice(4, 6)}/${day.slice(6, 8)}`;

  const snap = state.snapshot;
  $('#status').textContent = snap?.error
    ? '查詢失敗：' + snap.error
    : snap
      ? `${fmtTime(snap.fetchedAt)} 更新・每 30 秒自動查詢`
      : '尚未查詢';

  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const list = $('#watch-list');
  list.innerHTML = '';

  if (!state.watches.length) {
    list.innerHTML =
      '<div class="empty">還沒有監看任何診間。<br>按下方按鈕加入你今天要看的診。</div>';
  } else {
    for (const w of state.watches) list.appendChild(itemEl(w, byKey.get(watchKey(w))));
  }

  $('#alert-panel').hidden = !state.watches.length;
  $('#opt-notify').checked = !!state.prefs.notify;
  $('#opt-push').checked = !!state.prefs.push;
  $('#opt-wakelock').checked = !!state.prefs.wakeLock;
  $('#opt-sound').checked = !!state.prefs.sound;

  renderHint();
}

function itemEl(w, row) {
  const el = document.createElement('div');
  el.className = 'item';
  const cur = row ? row.CLC_MAXIMUM : null;
  const num = progressNum(cur);
  const phase = phaseOf(cur);
  let remaining = null;
  if (w.myNumber != null && num != null) remaining = Number(w.myNumber) - num;
  if (remaining != null) {
    if (remaining <= 0) el.classList.add('turn');
    else if (remaining <= Number(w.nearThreshold ?? 3)) el.classList.add('near');
  }

  const top = document.createElement('div');
  top.className = 'item-top';
  const nm = document.createElement('span');
  nm.className = 'item-room';
  nm.textContent = w.room;
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = `${w.shift}・${w.section}` + (w.doctor ? `・${w.doctor}` : '');
  top.append(nm, meta);

  const body = document.createElement('div');
  body.className = 'item-body';
  const left = document.createElement('div');
  if (!row) {
    left.innerHTML = '<span class="big text">今日無此診</span>';
  } else if (phase === 'open') {
    const l = document.createElement('span');
    l.className = 'big-label';
    l.textContent = '目前叫號';
    const n = document.createElement('span');
    n.className = 'big';
    n.textContent = String(num);
    left.append(l, n);
  } else {
    const t = document.createElement('span');
    t.className = 'big text';
    t.textContent = phase === 'finished' ? '看診結束' : '尚未開診';
    left.appendChild(t);
  }

  const right = document.createElement('div');
  right.className = 'item-right';
  const hi = el.classList.contains('near') || el.classList.contains('turn') ? ' class="hi"' : '';
  if (w.myNumber != null) {
    const mine = `你的號碼 <b>${w.myNumber}</b>`;
    if (remaining == null) right.innerHTML = mine;
    else if (remaining > 0) right.innerHTML = `${mine}<br>還有 <b${hi}>${remaining}</b> 位`;
    else if (remaining === 0) right.innerHTML = `${mine}<br><b class="hi">輪到你了</b>`;
    else right.innerHTML = `${mine}<br>已過號 <b class="hi">${-remaining}</b>`;
  } else {
    right.innerHTML = '<span style="opacity:.7">點一下設定號碼</span>';
  }

  body.append(left, right);
  el.append(top, body);
  el.addEventListener('click', () => openNumSheet(watchKey(w)));
  return el;
}

function renderHint() {
  const parts = [];
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (iOS && !standalone) {
    parts.push(
      '<b>iPhone 使用者請先「加入主畫面」</b>：點分享鍵 → 加入主畫面。iOS 只有從主畫面開啟時才能接收通知。'
    );
  }
  if (state.prefs.push) {
    parts.push('已開啟背景推播：App 關著、螢幕鎖住時，快輪到你也會收到通知。');
  } else {
    parts.push(
      '目前只在 <b>App 開著時</b>提醒。想要關掉手機也收得到，請開啟上面的「手機關著也要收到」。'
    );
  }
  parts.push('每天凌晨 00:00 會自動清除前一天的診間與號碼，隔天不用手動整理。');
  $('#hint').innerHTML = parts.join('<br><br>');
}

// ---------------------------------------------------------------- 選診間

function openSheet() {
  $('#sheet').hidden = false;
  keyword = '';
  $('#search').value = '';
  renderSheet();
}
const closeSheet = () => ($('#sheet').hidden = true);

function renderSheet() {
  const note = $('#sheet-note');
  const groups = groupRows(rows);
  const shifts = ['全部', ...groups.map((g) => g.shift)];
  if (!shifts.includes(shiftFilter)) shiftFilter = '全部';

  const tabs = $('#shift-tabs');
  tabs.innerHTML = '';
  for (const s of shifts) {
    const b = document.createElement('button');
    b.className = 'tab' + (s === shiftFilter ? ' active' : '');
    b.textContent = s;
    b.addEventListener('click', () => {
      shiftFilter = s;
      renderSheet();
    });
    tabs.appendChild(b);
  }

  const box = $('#clinic-list');
  box.innerHTML = '';
  if (!rows.length) {
    note.textContent = '尚未取得診間清單，請下拉重新整理。';
    return;
  }
  const d = rows[0].SCD_VISITDT;
  note.innerHTML = `今日（${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}）共 <b>${rows.length}</b> 個診間`;

  const picked = new Set(state.watches.map(watchKey));
  const kw = keyword.toLowerCase();
  let shown = 0;

  for (const g of groups) {
    if (shiftFilter !== '全部' && g.shift !== shiftFilter) continue;
    for (const sec of g.sections) {
      const items = sec.items.filter(
        (r) =>
          !kw ||
          `${r.SEC_SENAME} ${r.ROM_RONAME} ${r.EMP_EMPNAME}`.toLowerCase().includes(kw)
      );
      if (!items.length) continue;
      const h = document.createElement('div');
      h.className = 'grp';
      h.textContent = `${g.shift}・${sec.section}`;
      box.appendChild(h);
      for (const r of items) {
        shown++;
        const key = rowKey(r);
        const b = document.createElement('button');
        b.className = 'clinic' + (picked.has(key) ? ' on' : '');
        const ph = phaseOf(r.CLC_MAXIMUM);
        b.innerHTML =
          `<span class="nm"></span><span class="dr"></span>` +
          `<span class="pg${ph === 'open' ? '' : ' grey'}"></span>`;
        b.querySelector('.nm').textContent = r.ROM_RONAME;
        b.querySelector('.dr').textContent = r.EMP_EMPNAME || '';
        b.querySelector('.pg').textContent = progressText(r.CLC_MAXIMUM);
        b.addEventListener('click', () => pickClinic(r));
        box.appendChild(b);
      }
    }
  }
  if (!shown) box.innerHTML = '<div class="empty">沒有符合的診間</div>';
}

function pickClinic(r) {
  const key = rowKey(r);
  if (state.watches.some((w) => watchKey(w) === key)) {
    toast('已經在監看清單裡了');
    closeSheet();
    openNumSheet(key);
    return;
  }
  state.watches.push({
    ...DEFAULT_WATCH,
    shift: r.SHI_EASYNAME,
    section: r.SEC_SENAME,
    room: r.ROM_RONAME,
    doctor: r.EMP_EMPNAME
  });
  save();
  closeSheet();
  render();
  updateWakeLock();
  openNumSheet(key);
}

// ---------------------------------------------------------------- 我的號碼

function openNumSheet(key) {
  const w = state.watches.find((x) => watchKey(x) === key);
  if (!w) return;
  editingKey = key;
  $('#num-title').textContent = w.room;
  $('#num-input').value = w.myNumber ?? '';
  $('#num-threshold').value = w.nearThreshold ?? 3;
  $('#num-onchange').checked = !!w.notifyOnChange;
  $('#num-sheet').hidden = false;
  setTimeout(() => $('#num-input').focus(), 120);
}
const closeNumSheet = () => {
  $('#num-sheet').hidden = true;
  editingKey = null;
};

function saveNum() {
  const w = state.watches.find((x) => watchKey(x) === editingKey);
  if (w) {
    const v = $('#num-input').value.trim();
    w.myNumber = v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
    w.nearThreshold = Math.max(1, parseInt($('#num-threshold').value, 10) || 3);
    w.notifyOnChange = $('#num-onchange').checked;
    // 換號碼後把已提醒紀錄清掉，才會用新號碼重新判斷
    delete state.states[editingKey];
    save();
    syncToServer();
  }
  closeNumSheet();
  render();
}

function removeWatch() {
  state.watches = state.watches.filter((x) => watchKey(x) !== editingKey);
  delete state.states[editingKey];
  save();
  syncToServer();
  closeNumSheet();
  render();
  updateWakeLock();
}

// ---------------------------------------------------------------- 啟動

async function init() {
  load();
  clearIfNewDay(true);
  render();
  scheduleMidnight();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      /* http 或不支援時會失敗 */
    }
  }

  try {
    const cfg = await fetch(state.api + '/api/config').then((r) => r.json());
    pushConfig = cfg;
  } catch (e) {
    /* 沒設定好 API 時仍可顯示畫面 */
  }

  // 實際的訂閱狀態以瀏覽器為準
  const sub = await getSubscription().catch(() => null);
  if (state.prefs.push && !sub) state.prefs.push = false;

  await tick(true);
  startLoop();
  updateWakeLock();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearIfNewDay();
      tick();
      updateWakeLock();
    }
  });
  document.addEventListener('pointerdown', unlockAudio, { once: true });

  // 綁定
  $('#btn-refresh').addEventListener('click', async () => {
    const b = $('#btn-refresh');
    b.classList.add('spin');
    await tick(true);
    b.classList.remove('spin');
  });
  $('#btn-add').addEventListener('click', () => {
    if (!rows.length) tick(true).then(openSheet);
    else openSheet();
  });
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-bg').addEventListener('click', closeSheet);
  $('#search').addEventListener('input', (e) => {
    keyword = e.target.value.trim();
    renderSheet();
  });
  $('#num-close').addEventListener('click', closeNumSheet);
  $('#num-bg').addEventListener('click', closeNumSheet);
  $('#num-save').addEventListener('click', saveNum);
  $('#num-remove').addEventListener('click', removeWatch);
  $('#btn-clear').addEventListener('click', clearToday);

  $('#opt-notify').addEventListener('change', async (e) => {
    state.prefs.notify = e.target.checked && (await ensureNotifyPermission());
    if (e.target.checked && !state.prefs.notify) toast('通知權限被拒絕，請到系統設定開啟');
    save();
    render();
  });
  $('#opt-push').addEventListener('change', async (e) => {
    if (e.target.checked) {
      state.prefs.push = true;
      const ok = await enablePush();
      state.prefs.push = ok;
      if (ok) toast('已開啟背景推播');
    } else {
      state.prefs.push = false;
      await disablePush();
    }
    save();
    render();
  });
  $('#opt-wakelock').addEventListener('change', (e) => {
    state.prefs.wakeLock = e.target.checked;
    save();
    updateWakeLock();
  });
  $('#opt-sound').addEventListener('change', (e) => {
    state.prefs.sound = e.target.checked;
    unlockAudio();
    save();
  });
  $('#btn-test').addEventListener('click', async () => {
    unlockAudio();
    if (!(await ensureNotifyPermission())) return toast('通知權限被拒絕');
    if (state.prefs.push) {
      const sub = await getSubscription();
      if (sub) {
        const j = sub.toJSON();
        const r = await fetch(state.api + '/api/test-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: { endpoint: j.endpoint, keys: j.keys } })
        }).then((x) => x.json());
        return toast(r.ok ? '已送出背景推播測試' : '推播失敗：' + (r.error || r.status));
      }
    }
    await showNotification({
      key: 'test',
      urgent: true,
      title: '測試通知',
      body: '通知功能正常。實際提醒會顯示科別、診間與目前叫號。'
    });
    beep(true);
    toast('已送出測試通知');
  });
}

init();
