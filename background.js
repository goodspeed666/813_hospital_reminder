import {
  ALARM_NAME,
  DAILY_ALARM,
  IDLE_PERIOD_MINUTES,
  msUntilTaipeiMidnight,
  todayInTaipei,
  PAGE_URL,
  fetchProgress,
  getStore,
  phaseOf,
  progressNum,
  progressText,
  rowKey,
  watchKey
} from './common.js';

// ---------------------------------------------------------------- 生命週期

/**
 * 一次性修復：1.0.5 有個 bug，會在「沒有清掉過期資料」的情況下把 day 蓋成今天，
 * 導致之後任何以日期為依據的判斷都認為那些資料是今天的，永遠清不掉。
 * 沒有任何欄位還留著證據，所以只能用版本號做一次無條件清除，讓所有人回到乾淨狀態。
 */
const SCHEMA_VERSION = 2;

async function repairIfNeeded() {
  const { schemaVersion } = await chrome.storage.local.get('schemaVersion');
  if (schemaVersion >= SCHEMA_VERSION) return false;
  await chrome.storage.local.set({
    watches: [],
    states: {},
    snapshot: null,
    pollMode: 'active',
    day: todayInTaipei(),
    schemaVersion: SCHEMA_VERSION,
    lastReset: { at: Date.now(), day: todayInTaipei(), reason: 'repair-v' + SCHEMA_VERSION }
  });
  return true;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // 重新啟動時先回到正常頻率，確認過今天的班表後才決定要不要轉為 idle，
  // 否則昨天存下的 idle 狀態會讓今天早上慢半小時才發現診間開了
  await chrome.storage.local.set({ pollMode: 'active' });
  // 先做一次性修復，再走一般的跨日判斷
  if (!(await repairIfNeeded())) await resetIfNewDay('installed');
  await scheduleDailyReset();
  await setupAlarm('active');
  poll('installed');
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ pollMode: 'active' });
  if (!(await repairIfNeeded())) await resetIfNewDay('startup');
  await scheduleDailyReset();
  await setupAlarm('active');
  poll('startup');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) poll('alarm');
  else if (alarm.name === DAILY_ALARM) {
    await dailyReset('alarm'); // 內部會自己排下一次
    poll('after-reset');
  }
});

/**
 * 每天台北時間 00:00 清除前一天的紀錄。
 * 用一次性 alarm 並在觸發後重新排程，比固定 24 小時週期不容易因休眠而漂移。
 */
async function scheduleDailyReset() {
  await chrome.alarms.clear(DAILY_ALARM);
  chrome.alarms.create(DAILY_ALARM, { when: Date.now() + msUntilTaipeiMidnight() });
}

/**
 * 清除當日紀錄：監看的診間（含我的號碼）、比對狀態、進度快取。
 * 保留：通知與更新設定。
 */
async function dailyReset(reason) {
  const { settings } = await getStore();
  const today = todayInTaipei();
  if (settings.dailyReset === false) {
    // 使用者關掉自動清除時，只重置比對基準，保留監看清單
    await chrome.storage.local.set({ states: {}, day: today });
  } else {
    await chrome.storage.local.set({
      watches: [],
      states: {},
      snapshot: null,
      pollMode: 'active',
      day: today
    });
  }
  await chrome.storage.local.set({
    lastReset: { at: Date.now(), day: today, reason: reason || 'unknown' }
  });
  // 不論這次是由排程還是由輪詢的防呆路徑觸發，都要重新排下一次，
  // 否則電腦在半夜休眠、改由輪詢補清除時，專屬排程就再也不會被排上了
  await scheduleDailyReset();
  await setupAlarm('active');
  await updateBadge();
  return today;
}

/**
 * 資料的日期和今天不一樣就清除；回傳是否有清除。
 *
 * `day` 欄位是 1.0.5 才加的，從舊版升級上來的儲存資料沒有這個欄位。
 * 所以不能把「沒有 day」直接當成全新安裝，否則升級後那些過期資料反而清不掉——
 * 改成退回去看資料本身帶的日期（比對基準的 __date、或進度快取的日期）。
 */
async function resetIfNewDay(reason) {
  const store = await getStore();
  const today = todayInTaipei();
  // 先看「資料自己帶的日期」，最後才看 day 欄位。
  // 順序不能反過來：1.0.5 有個 bug 會在沒清資料的情況下把 day 蓋成今天，
  // 先看 day 的話那些過期資料就永遠被判定成今天的而清不掉。
  const dataDay = store.states?.__date || store.snapshot?.date || store.day || null;

  if (dataDay === today) {
    if (!store.day) await chrome.storage.local.set({ day: today });
    return false;
  }

  // 完全沒有日期線索：沒有任何監看資料就是全新安裝，只記下日期
  if (!dataDay && !store.watches.length) {
    await chrome.storage.local.set({ day: today });
    return false;
  }

  // 其餘情況（日期不是今天、或有監看資料但來源日期不明）一律視為過期
  await dailyReset(reason);
  return true;
}

async function setupAlarm(mode) {
  const store = await getStore();
  const settings = store.settings;
  if (!mode) mode = store.pollMode;
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.paused) {
    await updateBadge();
    return;
  }
  if (!store.watches.some((w) => w.enabled)) {
    await updateBadge();
    return;
  }
  // 監看的診間今天都已看診結束時，改成 30 分鐘確認一次就好（等隔天班表出來再恢復）
  // Chrome 對已封裝的擴充功能，週期下限為 0.5 分鐘（30 秒）
  const period =
    mode === 'idle'
      ? IDLE_PERIOD_MINUTES
      : Math.max(0.5, Number(settings.intervalMinutes) || 0.5);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: period,
    periodInMinutes: period
  });
}

/**
 * 監看中的診間是否都已經沒有東西好追了。
 * 「看診結束」或「今日班表沒有這個診」都算，兩者的進度都不會再變動。
 */
function nothingLeftToWatch(watches, byKey) {
  const enabled = watches.filter((w) => w.enabled);
  if (!enabled.length) return true; // 還沒設定監看目標，不用一直抓
  return enabled.every((w) => {
    const row = byKey.get(watchKey(w));
    if (!row) return true;
    return phaseOf(row.CLC_MAXIMUM) === 'finished';
  });
}

function configuredNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// ---------------------------------------------------------------- 輪詢主流程

let polling = null;
let pollingSince = 0;

async function poll(reason) {
  // 日期檢查一定要在「同時只跑一次查詢」的去重之外先做完。
  // 放在 doPoll 裡面的話，只要有一次查詢卡在網路上沒回來，
  // 之後每一次 poll 都只會拿到那個卡住的 promise，跨日清除就永遠不會執行。
  if (reason !== 'after-reset') {
    try {
      if (!(await repairIfNeeded())) await resetIfNewDay(reason);
    } catch (e) {
      /* 清除失敗不影響後續查詢 */
    }
  }

  // 看門狗：查詢卡超過 30 秒就放行新的一輪，不讓它把之後全部凍住
  if (polling && Date.now() - pollingSince < 30000) return polling;
  pollingSince = Date.now();
  polling = doPoll(reason)
    .catch(() => {})
    .finally(() => {
      polling = null;
    });
  return polling;
}

async function doPoll(reason) {
  // 日期檢查已經在 poll() 裡做過了，這裡只負責抓取與比對
  const { settings, watches, states, pollMode } = await getStore();
  if (settings.paused && reason !== 'manual') return;
  if (reason !== 'manual' && !watches.some((w) => w.enabled)) {
    await chrome.alarms.clear(ALARM_NAME);
    if (pollMode !== 'idle') await chrome.storage.local.set({ pollMode: 'idle' });
    await updateBadge();
    return;
  }

  let rows = null;
  let error = null;
  try {
    rows = await fetchProgress();
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }

  const snapshot = {
    fetchedAt: Date.now(),
    reason,
    error,
    date: rows && rows.length ? rows[0].SCD_VISITDT : null,
    rows: rows || []
  };

  if (error) {
    // 抓取失敗時保留上一次的資料，只記錄錯誤
    const prev = (await chrome.storage.local.get('snapshot')).snapshot;
    if (prev && prev.rows && prev.rows.length) {
      snapshot.rows = prev.rows;
      snapshot.date = prev.date;
      snapshot.stale = true;
    }
    await chrome.storage.local.set({ snapshot });
    await updateBadge();
    return;
  }

  await chrome.storage.local.set({ snapshot });

  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  const nextStates = { ...states };
  const events = [];
  const passedNumbers = new Map();

  // 換日：重置比對基準，不發通知
  const prevDate = states.__date;
  const dayChanged = prevDate && snapshot.date && prevDate !== snapshot.date;
  if (dayChanged) {
    for (const k of Object.keys(nextStates)) if (k !== '__date') delete nextStates[k];
  }
  nextStates.__date = snapshot.date;

  for (const w of watches) {
    if (!w.enabled) continue;
    const key = watchKey(w);
    const row = byKey.get(key);
    const prev = nextStates[key];

    if (!row) {
      nextStates[key] = { ...(prev || {}), missing: true };
      continue;
    }

    const cur = row.CLC_MAXIMUM;
    const curNum = progressNum(cur);
    const curPhase = phaseOf(cur);
    const myNumber = configuredNumber(w.myNumber);
    const passed = curNum != null && myNumber != null && curNum > myNumber;
    if (passed) passedNumbers.set(key, w.myNumber);
    const state = {
      progress: cur,
      now: row.CLC_VISITNO_NOW,
      phase: curPhase,
      missing: false,
      notifiedRemaining: prev ? prev.notifiedRemaining : undefined,
      notifiedPassed: prev ? prev.notifiedPassed : false
    };

    // Passing the configured number stops this watch silently. Do not reach
    // the first-seen, phase, near-number, or progress-change notification paths.
    if (passed) {
      nextStates[key] = state;
      continue;
    }

    // 第一次觀測（或剛換日）只記錄，不通知，避免安裝當下就跳一堆通知
    if (!prev || prev.missing || prev.progress === undefined) {
      nextStates[key] = state;
      continue;
    }

    const changed = String(prev.progress) !== String(cur);
    const phaseChanged = prev.phase !== curPhase;
    const label = `${w.section}／${w.room}（${w.shift}）`;

    // 1) 快輪到我了 —— 優先權最高，訊息裡會一併帶到進度變化
    let nearFired = false;
    if (w.notifyNear && myNumber != null && curNum != null) {
      const remaining = myNumber - curNum;
      const threshold = Number(w.nearThreshold ?? 3);
      if (remaining > 0 && remaining <= threshold) {
        if (state.notifiedRemaining !== remaining) {
          state.notifiedRemaining = remaining;
          state.notifiedPassed = false;
          nearFired = true;
          events.push({
            key,
            urgent: true,
            title: `快輪到你了！還剩 ${remaining} 位`,
            message: `${label}\n目前叫號 ${curNum}，你的號碼 ${w.myNumber}`
          });
        }
      } else if (remaining === 0) {
        if (state.notifiedRemaining !== 0) {
          state.notifiedRemaining = 0;
          nearFired = true;
          events.push({
            key,
            urgent: true,
            title: '輪到你了！',
            message: `${label}\n目前叫號 ${curNum}，正是你的號碼`
          });
        }
      } else {
        // 還很遠，重置提醒記錄
        state.notifiedRemaining = undefined;
      }
    }

    let fired = nearFired;

    // 2) 開診 / 看診結束 狀態改變
    if (!fired && w.notifyStatus && phaseChanged) {
      fired = true;
      if (curPhase === 'open') {
        events.push({
          key,
          urgent: false,
          title: '開始看診',
          message: `${label}\n目前叫號 ${progressText(cur)}`
        });
      } else if (curPhase === 'finished') {
        events.push({ key, urgent: false, title: '看診結束', message: label });
      } else if (curPhase === 'idle') {
        events.push({ key, urgent: false, title: '目前尚未開診', message: label });
      } else {
        fired = false;
      }
    }

    // 3) 進度號碼異動
    if (!fired && w.notifyOnChange && changed) {
      const extra =
        myNumber != null && curNum != null
          ? `　你是 ${w.myNumber} 號，還有 ${Math.max(0, myNumber - curNum)} 位`
          : '';
      events.push({
        key,
        urgent: false,
        title: `看診進度 ${progressText(prev.progress)} → ${progressText(cur)}`,
        message: `${label}${extra ? '\n' + extra.trim() : ''}`
      });
    }

    nextStates[key] = state;
  }

  // Merge stop flags into the latest saved watches so a settings change made
  // while fetchProgress() was in flight is preserved.
  const latestWatches = (await getStore()).watches;
  let updatedWatches = latestWatches;
  for (const [key, number] of passedNumbers) {
    const index = updatedWatches.findIndex((w) => watchKey(w) === key);
    if (index === -1 || !updatedWatches[index].enabled || updatedWatches[index].myNumber !== number) continue;
    if (updatedWatches === latestWatches) updatedWatches = latestWatches.slice();
    updatedWatches[index] = { ...updatedWatches[index], enabled: false };
  }

  await chrome.storage.local.set({
    states: nextStates,
    ...(updatedWatches === latestWatches ? {} : { watches: updatedWatches })
  });

  // 監看的診間都看診結束了就停止密集查詢，改成 30 分鐘確認一次，
  // 等隔天班表出來（或診間重新開診）再自動恢復原本的頻率。
  const anyEnabled = updatedWatches.some((w) => w.enabled);
  const nextMode = nothingLeftToWatch(updatedWatches, byKey) ? 'idle' : 'active';
  if (nextMode !== pollMode) await chrome.storage.local.set({ pollMode: nextMode });
  if (!settings.paused) {
    // 直接比對「實際的 alarm 週期」而不是只看模式有沒有變，
    // 這樣即使狀態不同步（例如瀏覽器重啟、設定被外部改動）也會自我修正
    if (!anyEnabled) {
      await setupAlarm(nextMode);
    } else {
      const want =
        nextMode === 'idle'
          ? IDLE_PERIOD_MINUTES
          : Math.max(0.5, Number(settings.intervalMinutes) || 0.5);
      const cur = await chrome.alarms.get(ALARM_NAME);
      if (!cur || cur.periodInMinutes !== want) await setupAlarm(nextMode);
    }
  }

  await updateBadge();

  if (events.length) {
    for (const ev of events) await notify(ev, settings);
    if (settings.sound) playSound(events.some((e) => e.urgent));
  }
}

// ---------------------------------------------------------------- 通知

async function notify(ev, settings) {
  // 同一個診間使用固定的通知 ID，新通知會取代舊的，避免堆疊一整排
  const id = 'watch::' + ev.key;
  await chrome.notifications.clear(id);
  await new Promise((resolve) => {
    chrome.notifications.create(
      id,
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: ev.title,
        message: ev.message,
        priority: ev.urgent ? 2 : 1,
        requireInteraction: !!settings.requireInteraction,
        silent: true // 系統音效關閉，改用擴充功能自己的提示音
      },
      () => {
        void chrome.runtime.lastError;
        resolve();
      }
    );
  });
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: PAGE_URL });
});

// ---------------------------------------------------------------- 音效（offscreen）

let creatingOffscreen = null;

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return true;
  } catch (e) {
    /* 舊版 Chrome 沒有 hasDocument，往下走 */
  }
  if (creatingOffscreen) {
    await creatingOffscreen;
    return true;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: '播放看診進度提醒音效'
    })
    .catch(() => {});
  await creatingOffscreen;
  creatingOffscreen = null;
  return true;
}

async function playSound(urgent) {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: 'play-sound', urgent: !!urgent });
  } catch (e) {
    /* 音效失敗不影響通知本身 */
  }
}

// ---------------------------------------------------------------- Badge

async function updateBadge() {
  const { settings, watches, snapshot, pollMode } = await getStore();

  if (!settings.badgeEnabled) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: '813國軍桃園總醫院新竹分院 看診進度提醒' });
    return;
  }

  const enabled = watches.filter((w) => w.enabled);
  if (!enabled.length) {
    await chrome.action.setBadgeText({ text: '' });
    const stoppedPassed =
      !snapshot?.error && !snapshot?.stale &&
      watches.some((w) => {
        const row = (snapshot?.rows || []).find((r) => rowKey(r) === watchKey(w));
        const current = progressNum(row?.CLC_MAXIMUM);
        const myNumber = configuredNumber(w.myNumber);
        return w.enabled === false && current != null && myNumber != null && current > myNumber;
      });
    await chrome.action.setTitle({
      title: stoppedPassed
        ? '813國軍桃園總醫院新竹分院 看診進度提醒（已過號，已停止監看）'
        : '813國軍桃園總醫院新竹分院 看診進度提醒（尚未設定監看診間）'
    });
    return;
  }

  const target =
    enabled.find((w) => watchKey(w) === settings.badgeKey) || enabled[0];
  const key = watchKey(target);
  const row = (snapshot?.rows || []).find((r) => rowKey(r) === key);

  if (settings.paused) {
    await chrome.action.setBadgeText({ text: '暫' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    await chrome.action.setTitle({ title: '813國軍桃園總醫院新竹分院 看診進度提醒（已暫停）' });
    return;
  }

  if (snapshot?.error && !snapshot?.rows?.length) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setTitle({ title: '813國軍桃園總醫院新竹分院 看診進度提醒：抓取失敗\n' + snapshot.error });
    return;
  }

  if (!row) {
    await chrome.action.setBadgeText({ text: '–' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    await chrome.action.setTitle({
      title: `${target.section}／${target.room}（${target.shift}）\n今日班表未出現此診`
    });
    return;
  }

  const cur = row.CLC_MAXIMUM;
  const num = progressNum(cur);
  const phase = phaseOf(cur);
  let text = '';
  let color = '#0f766e';

  if (phase === 'open') text = String(num);
  else if (phase === 'finished') (text = '完'), (color = '#6b7280');
  else (text = '–'), (color = '#6b7280');

  let title = `${target.section}／${target.room}（${target.shift}）\n目前看診進度：${progressText(cur)}`;
  if (target.myNumber != null && num != null) {
    const remaining = Number(target.myNumber) - num;
    title += `\n你的號碼 ${target.myNumber}，還有 ${Math.max(0, remaining)} 位`;
    const th = Number(target.nearThreshold ?? 3);
    if (remaining <= th) color = remaining <= 0 ? '#dc2626' : '#ea580c';
  }
  if (snapshot?.stale) title += '\n（上次抓取失敗，顯示的是舊資料）';
  if (pollMode === 'idle') title += `\n今日看診已結束，已停止密集查詢`;

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

// ---------------------------------------------------------------- 訊息介面

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'poll-now') {
    poll('manual').then(async () => sendResponse({ ok: true, store: await getStore() }));
    return true;
  }

  if (msg.type === 'settings-changed') {
    (async () => {
      await setupAlarm();
      await updateBadge();
      if (!msg.skipPoll) await poll('manual');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'test-notification') {
    (async () => {
      const { settings } = await getStore();
      await notify(
        {
          key: '__test__',
          urgent: true,
          title: '測試通知',
          message: '通知功能正常運作。\n實際提醒會顯示科別、診間與目前叫號。'
        },
        settings
      );
      if (settings.sound) playSound(true);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// 設定或監看清單變動時，即時更新 badge
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings || changes.watches) updateBadge();
});

// service worker 每次被喚醒都會重跑這裡：不依賴 onInstalled／onStartup 有沒有觸發，
// 一律確認一次修復與日期，並確保 alarm 還在
(async () => {
  try {
    if (!(await repairIfNeeded())) await resetIfNewDay('sw-start');
    if (!(await chrome.alarms.get(ALARM_NAME))) await setupAlarm();
    if (!(await chrome.alarms.get(DAILY_ALARM))) await scheduleDailyReset();
  } catch (e) {
    /* 啟動檢查失敗不能讓整個 service worker 掛掉 */
  }
})();
