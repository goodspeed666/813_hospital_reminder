// 共用常數與工具函式（background / options / popup 共用）

// 看診進度網頁：http://www.813.com.tw/WebService/link/show_call2.html
// 該網頁背後實際呼叫的 JSON API（_Str 為 base64 編碼的查詢參數）：
//   {"Functionname":"GET_REG_VISIT_PROGRESS_GET","Jsonmode":"true","SYSTEM":"REGWSAPI"}
export const API_URL =
  'http://www.813.com.tw/WebService/WebService.asmx/HISAPI' +
  '?_Str=eyJGdW5jdGlvbm5hbWUiOiJHRVRfUkVHX1ZJU0lUX1BST0dSRVNTX0dFVCIsIkpzb25tb2RlIjoidHJ1ZSIsIlNZU1RFTSI6IlJFR1dTQVBJIn0=';

export const PAGE_URL = 'http://www.813.com.tw/WebService/link/show_call2.html';

export const ALARM_NAME = 'poll-clinic-progress';

// 時段顯示順序
export const SHIFT_ORDER = ['上午', '下午', '晚上'];

export const DEFAULT_SETTINGS = {
  intervalMinutes: 1,        // 預設每 1 分鐘抓取一次（可在設定頁改成 30 秒／2／5 分鐘）
  paused: false,             // 暫停輪詢
  sound: true,               // 通知音效
  requireInteraction: true,  // 通知不自動消失，需手動關閉
  badgeEnabled: true,        // 工具列圖示顯示目前號碼
  badgeKey: null             // badge 要顯示哪一個監看項目（null = 第一個啟用的）
};

export const DEFAULT_WATCH = {
  enabled: true,
  notifyOnChange: true,   // 進度號碼一有異動就通知
  notifyNear: true,       // 快輪到我時通知
  notifyStatus: true,     // 開診 / 看診結束 狀態改變時通知
  myNumber: null,         // 我的看診號碼
  nearThreshold: 3        // 剩幾號時提醒
};

/** 一筆看診資料的唯一鍵：時段 + 科別 + 診間 */
export function rowKey(row) {
  return [row.SHI_EASYNAME, row.SEC_SENAME, row.ROM_RONAME].join('|');
}

export function watchKey(w) {
  return [w.shift, w.section, w.room].join('|');
}

/** 把「看診進度」欄位轉成數字；非數字（看診結束 / - / 空白）回傳 null */
export function progressNum(value) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

/** 判斷診間狀態：open 看診中 / finished 看診結束 / idle 尚未開診 */
export function phaseOf(value) {
  const s = String(value ?? '').trim();
  if (s === '看診結束') return 'finished';
  if (/^\d+$/.test(s)) return 'open';
  if (s === '' || s === '-') return 'idle';
  return 'other';
}

export function phaseLabel(phase) {
  return { open: '看診中', finished: '看診結束', idle: '尚未開診', other: '—' }[phase] || '—';
}

/** 顯示用的進度文字 */
export function progressText(value) {
  const s = String(value ?? '').trim();
  return s === '' || s === '-' ? '尚未開診' : s;
}

/** 從 API 抓取今日所有診間的看診進度（含逾時保護，避免連線卡住讓輪詢整個停擺） */
export async function fetchProgress(timeoutMs = 20000) {
  // 加上時間戳避免中間層快取
  const url = API_URL + '&_ts=' + Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(url, { cache: 'no-store', signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('連線逾時（超過 ' + timeoutMs / 1000 + ' 秒沒有回應）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 伺服器有時會回傳 XML 包住的字串，嘗試取出內容再解析
    const m = text.match(/<string[^>]*>([\s\S]*)<\/string>/);
    if (!m) throw new Error('回傳格式無法解析');
    data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  }
  if (!Array.isArray(data)) throw new Error('回傳格式非陣列');
  return data;
}

/** 依 時段 → 科別 → 診間 分組，供設定頁顯示 */
export function groupRows(rows) {
  const byShift = new Map();
  for (const r of rows) {
    const shift = r.SHI_EASYNAME || '其他';
    if (!byShift.has(shift)) byShift.set(shift, new Map());
    const bySection = byShift.get(shift);
    const section = r.SEC_SENAME || '其他';
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(r);
  }
  const shifts = [...byShift.keys()].sort(
    (a, b) => (SHIFT_ORDER.indexOf(a) + 1 || 99) - (SHIFT_ORDER.indexOf(b) + 1 || 99)
  );
  return shifts.map((shift) => ({
    shift,
    sections: [...byShift.get(shift).entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant'))
      .map(([section, items]) => ({ section, items }))
  }));
}

export async function getStore() {
  const s = await chrome.storage.local.get(['settings', 'watches', 'snapshot', 'states']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    watches: s.watches || [],
    snapshot: s.snapshot || null,
    states: s.states || {}
  };
}

export function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
