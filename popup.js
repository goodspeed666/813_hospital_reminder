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

const SVG = (inner) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
     stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON_PAUSE = SVG('<path d="M9 4v16M15 4v16"/>');
const ICON_PLAY = SVG('<path d="M6.5 4.3v15.4L19.5 12z" fill="currentColor" stroke-width="1.6"/>');
const ICON_REFRESH = SVG('<path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8"/><path d="M20.4 2.6v4.4H16"/>');

let store = null;

init();

async function init() {
  $('#btn-refresh').innerHTML = ICON_REFRESH;
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
  const idle = pollMode === 'idle' && watches.some((w) => w.enabled);

  const pauseBtn = $('#btn-pause');
  pauseBtn.innerHTML = settings.paused ? ICON_PLAY : ICON_PAUSE;
  pauseBtn.title = settings.paused ? '繼續自動查詢' : '暫停自動查詢';
  pauseBtn.setAttribute('aria-label', pauseBtn.title);
  document.body.classList.toggle('paused', !!settings.paused);
  document.body.classList.toggle('idle', !settings.paused && idle);

  const every = settings.intervalMinutes === 0.5 ? '30 秒' : `${settings.intervalMinutes} 分鐘`;
  if (settings.paused) {
    $('#updated').textContent = `停留在 ${formatTime(snapshot?.fetchedAt)}・按播放鍵繼續`;
  } else if (idle) {
    $('#updated').textContent = `今日看診已結束・已停止查詢`;
  } else {
    $('#updated').textContent = `${formatTime(snapshot?.fetchedAt)} 更新・每 ${every}自動查詢`;
  }

  const list = $('#list');
  list.innerHTML = '';

  if (snapshot?.error) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = '查詢失敗：' + snapshot.error + (snapshot.stale ? '（以下為上次資料）' : '');
    list.appendChild(e);
  }

  const enabled = watches.filter((w) => w.enabled);
  if (!enabled.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = '尚未設定要監看的診間。<br />到設定頁勾選科別與診間就會開始提醒。';
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
  top.innerHTML = `<span class="item-room"></span><span class="item-meta"></span>`;
  top.querySelector('.item-room').textContent = w.room;
  top.querySelector('.item-meta').textContent =
    `${w.shift}・${w.section}` + (w.doctor ? `・${w.doctor}` : '');
  el.appendChild(top);

  const body = document.createElement('div');
  body.className = 'item-body';

  const left = document.createElement('div');
  if (!row) {
    left.innerHTML = '<span class="big text">今日無此診</span>';
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
  const hi = near ? ' class="hi"' : '';
  if (w.myNumber != null) {
    const mine = `你的號碼 <b>${w.myNumber}</b>`;
    if (remaining == null) right.innerHTML = mine;
    else if (remaining > 0) right.innerHTML = `${mine}<br />還有 <b${hi}>${remaining}</b> 位`;
    else if (remaining === 0) right.innerHTML = `${mine}<br /><b class="hi">輪到你了</b>`;
    else right.innerHTML = `${mine}<br />已過號 <b class="hi">${-remaining}</b>`;
  } else if (row && phase === 'open') {
    right.textContent = '看診中';
  }
  body.appendChild(right);

  el.appendChild(body);
  return el;
}
