import {
  formatTime,
  getStore,
  phaseLabel,
  phaseOf,
  progressNum,
  progressText,
  rowKey,
  watchKey
} from './common.js';

const $ = (s) => document.querySelector(s);

const ICON_PATHS = {
  pause: [{ d: 'M9 4v16M15 4v16' }],
  play: [{ d: 'M6.5 4.3v15.4L19.5 12z', fill: 'currentColor', 'stroke-width': '1.6' }],
  refresh: [
    { d: 'M20.2 12a8.2 8.2 0 1 1-2.4-5.8' },
    { d: 'M20.4 2.6v4.4H16' }
  ]
};

let store = null;

init();

async function init() {
  $('#btn-refresh').replaceChildren(createIcon('refresh'));
  $('#btn-refresh').addEventListener('click', refresh);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#link-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  store = await getStore();
  render();
  refresh();
}

async function refresh() {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.classList.add('spin');
  try {
    await chrome.runtime.sendMessage({ type: 'poll-now' });
  } catch (e) {
    /* background 可能剛喚醒 */
  }
  store = await getStore();
  render();
  btn.disabled = false;
  btn.classList.remove('spin');
}

async function togglePause() {
  store.settings.paused = !store.settings.paused;
  await chrome.storage.local.set({ settings: store.settings });
  await chrome.runtime.sendMessage({
    type: 'settings-changed',
    skipPoll: store.settings.paused
  });
  store = await getStore();
  render();
}

function render() {
  const { settings, watches, snapshot, pollMode } = store;
  const enabled = watches.filter((w) => w.enabled);
  const idle = pollMode === 'idle' && enabled.length > 0;

  const pauseBtn = $('#btn-pause');
  pauseBtn.replaceChildren(createIcon(settings.paused ? 'play' : 'pause'));
  pauseBtn.title = settings.paused ? '繼續自動查詢' : '暫停自動查詢';
  pauseBtn.setAttribute('aria-label', pauseBtn.title);
  document.body.classList.toggle('paused', !!settings.paused);
  document.body.classList.toggle('idle', !settings.paused && idle);

  const every = settings.intervalMinutes === 0.5 ? '30 秒' : `${settings.intervalMinutes} 分鐘`;
  if (settings.paused) {
    $('#updated').textContent = `停留在 ${formatTime(snapshot?.fetchedAt)}・按播放鍵繼續`;
  } else if (idle) {
    $('#updated').textContent = `今日看診已結束・已停止查詢`;
  } else if (!enabled.length) {
    $('#updated').textContent = `停留在 ${formatTime(snapshot?.fetchedAt)}・目前沒有啟用中的監看`;
  } else {
    $('#updated').textContent = `${formatTime(snapshot?.fetchedAt)} 更新・每 ${every}自動查詢`;
  }

  const list = $('#list');
  list.replaceChildren();

  if (snapshot?.error) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = '查詢失敗：' + snapshot.error + (snapshot.stale ? '（以下為上次資料）' : '');
    list.appendChild(e);
  }

  if (!enabled.length) {
    const byKey = new Map((snapshot?.rows || []).map((r) => [rowKey(r), r]));
    const stoppedPassed =
      !snapshot?.error && !snapshot?.stale &&
      watches.some((w) => {
        if (w.enabled !== false || w.myNumber == null || String(w.myNumber).trim() === '') return false;
        const current = progressNum(byKey.get(watchKey(w))?.CLC_MAXIMUM);
        const mine = Number(w.myNumber);
        return current != null && Number.isFinite(mine) && current > mine;
      });
    const d = document.createElement('div');
    d.className = 'empty';
    d.appendChild(document.createTextNode(
      stoppedPassed ? '已過號，已停止監看。' : '尚未設定啟用中的監看診間。'
    ));
    d.appendChild(document.createElement('br'));
    d.appendChild(document.createTextNode(
      stoppedPassed
        ? '到設定頁更改號碼並儲存，即可重新開始監看。'
        : '到設定頁勾選科別與診間就會開始提醒。'
    ));
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = '前往設定';
    b.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
    d.appendChild(b);
    list.appendChild(d);
    return;
  }

  const byKey = new Map((snapshot?.rows || []).map((r) => [rowKey(r), r]));

  for (const w of enabled) {
    const key = watchKey(w);
    const row = byKey.get(key);
    list.appendChild(itemEl(w, row));
  }
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
  const roomName = document.createElement('span');
  roomName.className = 'item-room';
  roomName.textContent = w.room;
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent =
    `${w.shift}・${w.section}` + (w.doctor ? `・${w.doctor}` : '');
  top.append(roomName, meta);
  el.appendChild(top);

  const body = document.createElement('div');
  body.className = 'item-body';

  const left = document.createElement('div');
  if (!row) {
    const missing = document.createElement('span');
    missing.className = 'big text';
    missing.textContent = '今日無此診';
    left.appendChild(missing);
  } else if (phase === 'open') {
    const lbl = document.createElement('span');
    lbl.className = 'big-label';
    lbl.textContent = '目前叫號';
    const n = document.createElement('span');
    n.className = 'big';
    n.textContent = String(num);
    left.append(lbl, n);
  } else {
    const t = document.createElement('span');
    t.className = 'big text';
    t.textContent = progressText(cur) === '尚未開診' ? '尚未開診' : phaseLabel(phase);
    left.appendChild(t);
  }
  body.appendChild(left);

  const right = document.createElement('div');
  right.className = 'item-right';
  const near = el.classList.contains('near') || el.classList.contains('turn');
  if (w.myNumber != null) {
    right.appendChild(document.createTextNode('你的號碼 '));
    const number = document.createElement('b');
    number.textContent = String(w.myNumber);
    right.appendChild(number);
    if (remaining != null) {
      right.appendChild(document.createElement('br'));
      if (remaining > 0) {
        right.appendChild(document.createTextNode('還有 '));
        const count = document.createElement('b');
        if (near) count.className = 'hi';
        count.textContent = String(remaining);
        right.appendChild(count);
        right.appendChild(document.createTextNode(' 位'));
      } else if (remaining === 0) {
        const message = document.createElement('b');
        message.className = 'hi';
        message.textContent = '輪到你了';
        right.appendChild(message);
      } else {
        right.appendChild(document.createTextNode('已過號 '));
        const count = document.createElement('b');
        count.className = 'hi';
        count.textContent = String(-remaining);
        right.appendChild(count);
      }
    }
  } else if (row && phase === 'open') {
    right.textContent = '看診中';
  }
  body.appendChild(right);

  el.appendChild(body);
  return el;
}

function createIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.1');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const attributes of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries(attributes)) path.setAttribute(key, value);
    svg.appendChild(path);
  }
  return svg;
}
