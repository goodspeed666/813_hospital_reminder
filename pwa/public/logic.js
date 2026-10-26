// 共用判斷邏輯：Worker 與前端 PWA 都用同一份，行為才會一致。
// 這份邏輯是從 Chrome 擴充功能移植過來的（已經過完整測試）。

export const API_URL =
  'http://www.813.com.tw/WebService/WebService.asmx/HISAPI' +
  '?_Str=eyJGdW5jdGlvbm5hbWUiOiJHRVRfUkVHX1ZJU0lUX1BST0dSRVNTX0dFVCIsIkpzb25tb2RlIjoidHJ1ZSIsIlNZU1RFTSI6IlJFR1dTQVBJIn0=';

export const PAGE_URL = 'http://www.813.com.tw/WebService/link/show_call2.html';
export const SHIFT_ORDER = ['上午', '下午', '晚上'];
export const TZ = 'Asia/Taipei';

/** 台北時區的今天，格式 YYYYMMDD（醫院 API 用的格式） */
export function todayInTaipei(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  return parts.replace(/-/g, '');
}

export function rowKey(row) {
  return [row.SHI_EASYNAME, row.SEC_SENAME, row.ROM_RONAME].join('|');
}

export function watchKey(w) {
  return [w.shift, w.section, w.room].join('|');
}

export function progressNum(value) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

/** open 看診中 / finished 看診結束 / idle 尚未開診 */
export function phaseOf(value) {
  const s = String(value ?? '').trim();
  if (s === '看診結束') return 'finished';
  if (/^\d+$/.test(s)) return 'open';
  if (s === '' || s === '-') return 'idle';
  return 'other';
}

export function progressText(value) {
  const s = String(value ?? '').trim();
  return s === '' || s === '-' ? '尚未開診' : s;
}

export function parseProgressPayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const m = text.match(/<string[^>]*>([\s\S]*)<\/string>/);
    if (!m) throw new Error('回傳格式無法解析');
    data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  }
  if (!Array.isArray(data)) throw new Error('回傳格式非陣列');
  return data;
}

export async function fetchProgress(fetchImpl = fetch, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(API_URL + '&_ts=' + Date.now(), {
      signal: ac.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseProgressPayload(await res.text());
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('連線逾時');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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
  return [...byShift.keys()]
    .sort((a, b) => (SHIFT_ORDER.indexOf(a) + 1 || 99) - (SHIFT_ORDER.indexOf(b) + 1 || 99))
    .map((shift) => ({
      shift,
      sections: [...byShift.get(shift).entries()]
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant'))
        .map(([section, items]) => ({ section, items }))
    }));
}

export const DEFAULT_WATCH = {
  enabled: true,
  notifyOnChange: false, // 手機推播預設只在快輪到時通知，避免整天被吵
  notifyNear: true,
  notifyStatus: true,
  myNumber: null,
  nearThreshold: 3
};

/**
 * 比對一輪資料，產生要發出的通知，並回傳新的比對狀態。
 * 純函式，不碰 I/O，方便測試。
 *
 * @returns {{events: Array, states: Object, watches: Array, allDone: boolean}}
 */
export function evaluate(watches, rows, prevStates = {}, opts = {}) {
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const states = { ...prevStates };
  const events = [];
  let updatedWatches = watches;
  const disableWatch = (watch) => {
    if (updatedWatches === watches) updatedWatches = watches.slice();
    const index = watches.indexOf(watch);
    if (index !== -1) updatedWatches[index] = { ...watch, enabled: false };
  };
  const date = rows.length ? rows[0].SCD_VISITDT : null;

  // 換日：重置比對基準，不發通知
  if (states.__date && date && states.__date !== date) {
    for (const k of Object.keys(states)) if (k !== '__date') delete states[k];
  }
  if (date) states.__date = date;

  const enabled = watches.filter((w) => w.enabled !== false);

  for (const w of enabled) {
    const key = watchKey(w);
    const row = byKey.get(key);
    const prev = states[key];

    if (!row) {
      states[key] = { ...(prev || {}), missing: true };
      continue;
    }

    const cur = row.CLC_MAXIMUM;
    const curNum = progressNum(cur);
    const curPhase = phaseOf(cur);
    const configuredNumber = w.myNumber;
    const myNumber = configuredNumber != null && String(configuredNumber).trim() !== '' && Number.isFinite(Number(configuredNumber))
      ? Number(configuredNumber)
      : null;
    const passed = curNum != null && myNumber != null && curNum > myNumber;
    const state = {
      progress: cur,
      phase: curPhase,
      missing: false,
      notifiedRemaining: prev ? prev.notifiedRemaining : undefined,
      notifiedPassed: prev ? prev.notifiedPassed : false
    };

    // Passing the configured number stops this watch silently before any
    // first-seen, status, near-number, or progress-change notification path.
    if (passed) {
      states[key] = state;
      disableWatch(w);
      continue;
    }

    // 第一次觀測只記錄基準，不通知
    if (!prev || prev.missing || prev.progress === undefined) {
      states[key] = state;
      if (passed) disableWatch(w);
      if (opts.firstSeenNotify && !passed) {
        events.push({
          key,
          urgent: false,
          title: '開始監看',
          body: `${w.section}／${w.room}（${w.shift}）\n目前叫號 ${progressText(cur)}`
        });
      }
      continue;
    }

    const changed = String(prev.progress) !== String(cur);
    const phaseChanged = prev.phase !== curPhase;
    const label = `${w.section}／${w.room}（${w.shift}）`;
    let fired = false;

    // 1) 快輪到我了
    if (w.notifyNear && myNumber != null && curNum != null) {
      const remaining = myNumber - curNum;
      const threshold = Number(w.nearThreshold ?? 3);
      if (remaining > 0 && remaining <= threshold) {
        if (state.notifiedRemaining !== remaining) {
          state.notifiedRemaining = remaining;
          state.notifiedPassed = false;
          fired = true;
          events.push({
            key,
            urgent: true,
            title: `快輪到你了！還剩 ${remaining} 位`,
            body: `${label}\n目前叫號 ${curNum}，你的號碼 ${w.myNumber}`
          });
        }
      } else if (remaining === 0) {
        if (state.notifiedRemaining !== 0) {
          state.notifiedRemaining = 0;
          fired = true;
          events.push({
            key,
            urgent: true,
            title: '輪到你了！',
            body: `${label}\n目前叫號 ${curNum}，正是你的號碼`
          });
        }
      } else {
        state.notifiedRemaining = undefined;
      }
    }

    // 2) 開診 / 看診結束
    if (!fired && w.notifyStatus && phaseChanged) {
      if (curPhase === 'open') {
        fired = true;
        events.push({
          key,
          urgent: false,
          title: '開始看診',
          body: `${label}\n目前叫號 ${progressText(cur)}`
        });
      } else if (curPhase === 'finished') {
        fired = true;
        events.push({ key, urgent: false, title: '看診結束', body: label });
      } else if (curPhase === 'idle') {
        fired = true;
        events.push({ key, urgent: false, title: '目前尚未開診', body: label });
      }
    }

    // 3) 進度異動
    if (!fired && w.notifyOnChange && changed) {
      const extra =
        w.myNumber != null && curNum != null
          ? `\n你是 ${w.myNumber} 號，還有 ${Math.max(0, Number(w.myNumber) - curNum)} 位`
          : '';
      events.push({
        key,
        urgent: false,
        title: `看診進度 ${progressText(prev.progress)} → ${progressText(cur)}`,
        body: label + extra
      });
    }

    states[key] = state;
    if (passed) disableWatch(w);
  }

  // 監看的診間是否都沒東西好追了（看診結束或今日無此診）
  const updatedEnabled = updatedWatches.filter((w) => w.enabled !== false);
  const allDone =
    updatedEnabled.length === 0 ||
    updatedEnabled.every((w) => {
      const row = byKey.get(watchKey(w));
      return !row || phaseOf(row.CLC_MAXIMUM) === 'finished';
    });

  return { events, states, watches: updatedWatches, allDone };
}
