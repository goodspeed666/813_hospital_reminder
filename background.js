import {
  ALARM_NAME,
  IDLE_PERIOD_MINUTES,
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

chrome.runtime.onInstalled.addListener(async (details) => {
  // 重新啟動時先回到正常頻率，確認過今天的班表後才決定要不要轉為 idle，
  // 否則昨天存下的 idle 狀態會讓今天早上慢半小時才發現診間開了
  await chrome.storage.local.set({ pollMode: 'active' });
  await setupAlarm('active');
  poll('installed');
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ pollMode: 'active' });
  await setupAlarm('active');
  poll('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) poll('alarm');
});

async function setupAlarm(mode) {
  const store = await getStore();
  const settings = store.settings;
  if (!mode) mode = store.pollMode;
  await chrome.alarms.clear(ALARM_NAME);
  if (settings.paused) {
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

// ---------------------------------------------------------------- 輪詢主流程

let polling = null;

function poll(reason) {
  if (polling) return polling;
  polling = doPoll(reason).finally(() => {
    polling = null;
  });
  return polling;
}

async function doPoll(reason) {
  const { settings, watches, states, pollMode } = await getStore();
  if (settings.paused && reason !== 'manual') return;

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
    const state = {
      progress: cur,
      now: row.CLC_VISITNO_NOW,
      phase: curPhase,
      missing: false,
      notifiedRemaining: prev ? prev.notifiedRemaining : undefined,
      notifiedPassed: prev ? prev.notifiedPassed : false
    };

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
    if (w.notifyNear && w.myNumber != null && curNum != null) {
      const remaining = Number(w.myNumber) - curNum;
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
      } else if (remaining < 0) {
        if (!state.notifiedPassed) {
          state.notifiedPassed = true;
          nearFired = true;
          events.push({
            key,
            urgent: true,
            title: '已經過號',
            message: `${label}\n目前叫號 ${curNum}，你的號碼 ${w.myNumber}`
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
        w.myNumber != null && curNum != null
          ? `　你是 ${w.myNumber} 號，還有 ${Math.max(0, Number(w.myNumber) - curNum)} 位`
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

  await chrome.storage.local.set({ states: nextStates });

  // 監看的診間都看診結束了就停止密集查詢，改成 30 分鐘確認一次，
  // 等隔天班表出來（或診間重新開診）再自動恢復原本的頻率。
  const nextMode = nothingLeftToWatch(watches, byKey) ? 'idle' : 'active';
  if (nextMode !== pollMode) await chrome.storage.local.set({ pollMode: nextMode });
  if (!settings.paused) {
    // 直接比對「實際的 alarm 週期」而不是只看模式有沒有變，
    // 這樣即使狀態不同步（例如瀏覽器重啟、設定被外部改動）也會自我修正
    const want =
      nextMode === 'idle'
        ? IDLE_PERIOD_MINUTES
        : Math.max(0.5, Number(settings.intervalMinutes) || 0.5);
    const cur = await chrome.alarms.get(ALARM_NAME);
    if (!cur || cur.periodInMinutes !== want) await setupAlarm(nextMode);
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
    await chrome.action.setTitle({ title: '813國軍桃園總醫院新竹分院 看診進度提醒（尚未設定監看診間）' });
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

// service worker 被喚醒時確保 alarm 還在
chrome.alarms.get(ALARM_NAME).then((a) => {
  if (!a) setupAlarm();
});
