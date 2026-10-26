import {
  DEFAULT_SETTINGS,
  DEFAULT_WATCH,
  fetchProgress,
  getStore,
  groupRows,
  phaseOf,
  progressText,
  rowKey,
  watchKey
} from './common.js';

const $ = (sel) => document.querySelector(sel);

let settings = { ...DEFAULT_SETTINGS };
let watchMap = new Map(); // key -> watch
let rows = [];
let shiftFilter = '全部';
let keyword = '';
let dirty = false;

// ----------------------------------------------------------------- 初始化

init();

async function init() {
  const store = await getStore();
  settings = store.settings;
  watchMap = new Map(store.watches.map((w) => [watchKey(w), { ...DEFAULT_WATCH, ...w }]));

  applySettingsToForm();
  bindEvents();

  // 先用背景已抓到的資料立即顯示，再重新抓一次最新的
  if (store.snapshot && store.snapshot.rows && store.snapshot.rows.length) {
    rows = store.snapshot.rows;
    render();
  }
  await reload();
}

function applySettingsToForm() {
  $('#interval').value = String(settings.intervalMinutes);
  $('#sound').checked = !!settings.sound;
  $('#require-interaction').checked = !!settings.requireInteraction;
  $('#badge-enabled').checked = !!settings.badgeEnabled;
  $('#daily-reset').checked = settings.dailyReset !== false;
}

function bindEvents() {
  $('#interval').addEventListener('change', (e) => {
    settings.intervalMinutes = parseFloat(e.target.value);
    markDirty();
  });
  $('#sound').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    markDirty();
  });
  $('#require-interaction').addEventListener('change', (e) => {
    settings.requireInteraction = e.target.checked;
    markDirty();
  });
  $('#badge-enabled').addEventListener('change', (e) => {
    settings.badgeEnabled = e.target.checked;
    markDirty();
  });
  $('#daily-reset').addEventListener('change', (e) => {
    settings.dailyReset = e.target.checked;
    markDirty();
  });
  $('#btn-clear-watches').addEventListener('click', async () => {
    if (!watchMap.size) return setStatus('目前沒有監看中的診間', 'ok');
    watchMap.clear();
    settings.badgeKey = null;
    await chrome.storage.local.set({ watches: [], states: {}, settings });
    await chrome.runtime.sendMessage({ type: 'settings-changed' });
    dirty = false;
    render();
    setStatus('已清除監看清單', 'ok');
  });
  $('#badge-key').addEventListener('change', (e) => {
    settings.badgeKey = e.target.value || null;
    markDirty();
  });

  $('#btn-reload').addEventListener('click', reload);
  $('#btn-save').addEventListener('click', save);
  $('#btn-test').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'test-notification' });
    setStatus('已送出測試通知', 'ok');
  });
  $('#btn-reset').addEventListener('click', () => {
    // 只還原「通知與更新設定」，不動已經勾選的監看診間
    settings = { ...DEFAULT_SETTINGS, badgeKey: settings.badgeKey };
    applySettingsToForm();
    renderBadgeSelect();
    dirty = true;
    setStatus('已帶入預設值，按「儲存設定」套用（監看中的診間不受影響）', 'dirty');
  });

  $('#search').addEventListener('input', (e) => {
    keyword = e.target.value.trim();
    render();
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ----------------------------------------------------------------- 資料

async function reload() {
  const note = $('#list-note');
  $('#btn-reload').disabled = true;
  note.textContent = '正在抓取今日診間清單…';
  try {
    rows = await fetchProgress();
    const date = rows.length ? formatDate(rows[0].SCD_VISITDT) : '';
    note.replaceChildren();
    appendText(note, `今日（${date}）共 `);
    const count = document.createElement('b');
    count.textContent = String(rows.length);
    note.appendChild(count);
    appendText(note, ' 個診間。勾選要監看的診間後，記得按右下角「儲存設定」。');
    render();
  } catch (e) {
    note.replaceChildren();
    const error = document.createElement('span');
    error.style.color = 'var(--danger)';
    error.textContent = '抓取失敗：' + String(e.message || e);
    note.appendChild(error);
    appendText(note, '　請確認網路連線後再按「重新抓取診間清單」。');
  } finally {
    $('#btn-reload').disabled = false;
  }
}

function formatDate(s) {
  if (!s || s.length !== 8) return s || '';
  return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
}

// ----------------------------------------------------------------- 畫面

function render() {
  renderShiftTabs();
  renderList();
  renderOrphans();
  renderBadgeSelect();
}

function renderShiftTabs() {
  const shifts = ['全部', ...groupRows(rows).map((g) => g.shift)];
  const box = $('#shift-tabs');
  if (!shifts.includes(shiftFilter)) shiftFilter = '全部';
  box.replaceChildren();
  for (const s of shifts) {
    const b = document.createElement('button');
    b.className = 'tab' + (s === shiftFilter ? ' active' : '');
    b.textContent = s;
    b.addEventListener('click', () => {
      shiftFilter = s;
      render();
    });
    box.appendChild(b);
  }
}

function matches(row) {
  if (shiftFilter !== '全部' && row.SHI_EASYNAME !== shiftFilter) return false;
  if (!keyword) return true;
  return [row.SEC_SENAME, row.ROM_RONAME, row.EMP_EMPNAME]
    .join(' ')
    .toLowerCase()
    .includes(keyword.toLowerCase());
}

function renderList() {
  const box = $('#clinic-list');
  box.replaceChildren();
  const groups = groupRows(rows.filter(matches));

  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = '沒有符合的診間。';
    box.appendChild(empty);
    return;
  }

  for (const g of groups) {
    const gEl = document.createElement('div');
    gEl.className = 'shift-group';
    const count = g.sections.reduce((n, s) => n + s.items.length, 0);
    const title = document.createElement('div');
    title.className = 'shift-title';
    appendText(title, g.shift);
    const countEl = document.createElement('span');
    countEl.className = 'muted small';
    countEl.style.fontWeight = '400';
    countEl.textContent = `${count} 診`;
    title.appendChild(countEl);
    gEl.appendChild(title);

    for (const sec of g.sections) {
      const t = document.createElement('div');
      t.className = 'section-title';
      t.textContent = sec.section;
      gEl.appendChild(t);
      for (const row of sec.items) gEl.appendChild(clinicRow(row));
    }
    box.appendChild(gEl);
  }
}

function clinicRow(row) {
  const key = rowKey(row);
  const watch = watchMap.get(key);
  const on = !!watch && watch.enabled !== false;

  const el = document.createElement('div');
  el.className = 'clinic' + (on ? ' on' : '');

  const main = document.createElement('label');
  main.className = 'clinic-main';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = on;
  main.appendChild(checkbox);
  const name = document.createElement('span');
  name.className = 'clinic-name';
  name.textContent = row.ROM_RONAME || '';
  main.appendChild(name);
  const doctor = document.createElement('span');
  doctor.className = 'clinic-doc';
  doctor.textContent = row.EMP_EMPNAME || '';
  main.appendChild(doctor);
  const progress = document.createElement('span');
  progress.className = 'clinic-prog';
  progress.appendChild(progressPill(row));
  main.appendChild(progress);
  el.appendChild(main);

  checkbox.addEventListener('change', (e) => {
    if (e.target.checked) {
      const existing = watchMap.get(key);
      watchMap.set(key, {
        ...DEFAULT_WATCH,
        ...existing,
        shift: row.SHI_EASYNAME,
        section: row.SEC_SENAME,
        room: row.ROM_RONAME,
        doctor: row.EMP_EMPNAME,
        enabled: true
      });
    } else {
      watchMap.delete(key);
      if (settings.badgeKey === key) settings.badgeKey = null;
    }
    markDirty();
    render();
  });

  if (watch) el.appendChild(detailPanel(key, watch));
  return el;
}

function progressPill(row) {
  const phase = phaseOf(row.CLC_MAXIMUM);
  const cls = phase === 'open' ? '' : phase === 'finished' ? ' grey' : ' grey';
  const pill = document.createElement('span');
  pill.className = `pill${cls}`;
  pill.textContent = progressText(row.CLC_MAXIMUM);
  return pill;
}

function detailPanel(key, watch) {
  const d = document.createElement('div');
  d.className = 'detail';
  if (watch.enabled === false) {
    const stopped = document.createElement('div');
    stopped.className = 'muted small';
    stopped.textContent = '已過號，已停止監看。更改號碼並儲存即可重新啟用。';
    d.appendChild(stopped);
  }

  const numberLabel = document.createElement('label');
  numberLabel.title = '填了號碼才能做「快輪到我」提醒；留空則只在進度異動時通知';
  appendText(numberLabel, '我的號碼');
  const numberInput = document.createElement('input');
  numberInput.type = 'number';
  numberInput.min = '0';
  numberInput.step = '1';
  numberInput.className = 'my-number';
  numberInput.value = watch.myNumber ?? '';
  numberInput.placeholder = '選填';
  numberLabel.appendChild(numberInput);
  d.appendChild(numberLabel);

  const nearLabel = document.createElement('label');
  const nearCheckbox = document.createElement('input');
  nearCheckbox.type = 'checkbox';
  nearCheckbox.className = 'notify-near';
  nearCheckbox.checked = !!watch.notifyNear;
  nearLabel.appendChild(nearCheckbox);
  appendText(nearLabel, '快輪到我時通知（剩');
  const thresholdInput = document.createElement('input');
  thresholdInput.type = 'number';
  thresholdInput.min = '1';
  thresholdInput.max = '50';
  thresholdInput.step = '1';
  thresholdInput.className = 'near-threshold';
  thresholdInput.style.width = '58px';
  thresholdInput.value = watch.nearThreshold ?? 3;
  nearLabel.appendChild(thresholdInput);
  appendText(nearLabel, ' 號）');
  d.appendChild(nearLabel);

  const separator = document.createElement('div');
  separator.className = 'sep';
  d.appendChild(separator);

  const changeLabel = document.createElement('label');
  const changeCheckbox = document.createElement('input');
  changeCheckbox.type = 'checkbox';
  changeCheckbox.className = 'notify-change';
  changeCheckbox.checked = !!watch.notifyOnChange;
  changeLabel.appendChild(changeCheckbox);
  appendText(changeLabel, '進度號碼一有異動就通知');
  d.appendChild(changeLabel);

  const statusLabel = document.createElement('label');
  const statusCheckbox = document.createElement('input');
  statusCheckbox.type = 'checkbox';
  statusCheckbox.className = 'notify-status';
  statusCheckbox.checked = !!watch.notifyStatus;
  statusLabel.appendChild(statusCheckbox);
  appendText(statusLabel, '開始看診 / 看診結束時通知');
  d.appendChild(statusLabel);

  const upd = (patch) => {
    watchMap.set(key, { ...watchMap.get(key), ...patch });
    markDirty();
  };

  numberInput.addEventListener('input', (e) => {
    const v = e.target.value.trim();
    upd({ myNumber: v === '' ? null : Math.max(0, parseInt(v, 10) || 0), enabled: true });
  });
  thresholdInput.addEventListener('input', (e) => {
    upd({ nearThreshold: Math.max(1, parseInt(e.target.value, 10) || 3) });
  });
  nearCheckbox.addEventListener('change', (e) =>
    upd({ notifyNear: e.target.checked })
  );
  changeCheckbox.addEventListener('change', (e) =>
    upd({ notifyOnChange: e.target.checked })
  );
  statusCheckbox.addEventListener('change', (e) =>
    upd({ notifyStatus: e.target.checked })
  );

  return d;
}

function renderOrphans() {
  const present = new Set(rows.map(rowKey));
  const orphans = [...watchMap.entries()].filter(([k]) => !present.has(k));
  const card = $('#orphan-card');
  const box = $('#orphan-list');
  card.hidden = orphans.length === 0;
  box.replaceChildren();

  for (const [key, w] of orphans) {
    const item = document.createElement('div');
    item.className = 'orphan-wrap';
    const el = document.createElement('div');
    el.className = 'orphan';
    const grow = document.createElement('span');
    grow.className = 'grow';
    appendText(grow, `${w.section || ''}／${w.room || ''}`);
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = `（${w.shift || ''}${w.myNumber != null ? '・我的號碼 ' + w.myNumber : ''}）`;
    grow.appendChild(meta);
    if (w.enabled === false) {
      const stopped = document.createElement('span');
      stopped.className = 'muted small';
      stopped.textContent = '已停止監看';
      grow.appendChild(stopped);
    }
    el.appendChild(grow);
    if (w.enabled === false) {
      const resume = document.createElement('button');
      resume.className = 'orphan-resume';
      resume.textContent = '重新啟用';
      resume.addEventListener('click', () => {
        const current = watchMap.get(key);
        if (!current) return;
        watchMap.set(key, { ...current, enabled: true });
        markDirty();
        render();
      });
      el.appendChild(resume);
    }
    const btn = document.createElement('button');
    btn.textContent = '移除';
    btn.addEventListener('click', () => {
      watchMap.delete(key);
      if (settings.badgeKey === key) settings.badgeKey = null;
      markDirty();
      render();
    });
    el.appendChild(btn);
    item.appendChild(el);
    if (w.enabled === false) item.appendChild(detailPanel(key, w));
    box.appendChild(item);
  }
}

function renderBadgeSelect() {
  const sel = $('#badge-key');
  sel.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自動（第一個監看的診間）';
  sel.appendChild(auto);

  for (const [key, w] of watchMap) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${w.section}／${w.room}（${w.shift}）`;
    sel.appendChild(o);
  }
  sel.value = watchMap.has(settings.badgeKey) ? settings.badgeKey : '';
}

// ----------------------------------------------------------------- 儲存

function markDirty() {
  dirty = true;
  setStatus('有尚未儲存的變更', 'dirty');
}

function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'small ' + (kind === 'ok' ? 'status-ok' : kind === 'dirty' ? 'status-dirty' : 'muted');
}

async function save() {
  const watches = [...watchMap.values()].map((w) => ({ ...DEFAULT_WATCH, ...w }));
  await chrome.storage.local.set({ settings, watches });
  await chrome.runtime.sendMessage({ type: 'settings-changed' });
  dirty = false;
  const n = watches.filter((w) => w.enabled).length;
  setStatus(`已儲存　監看 ${n} 個診間`, 'ok');
}

function appendText(element, value) {
  element.appendChild(document.createTextNode(String(value ?? '')));
}
