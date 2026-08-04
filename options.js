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
    note.innerHTML = `今日（${date}）共 <b>${rows.length}</b> 個診間。勾選要監看的診間後，記得按右下角「儲存設定」。`;
    render();
  } catch (e) {
    note.innerHTML = `<span style="color:var(--danger)">抓取失敗：${escapeHtml(
      String(e.message || e)
    )}</span>　請確認網路連線後再按「重新抓取診間清單」。`;
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
  box.innerHTML = '';
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
  box.innerHTML = '';
  const groups = groupRows(rows.filter(matches));

  if (!groups.length) {
    box.innerHTML = '<p class="muted small">沒有符合的診間。</p>';
    return;
  }

  for (const g of groups) {
    const gEl = document.createElement('div');
    gEl.className = 'shift-group';
    const count = g.sections.reduce((n, s) => n + s.items.length, 0);
    gEl.innerHTML = `<div class="shift-title">${escapeHtml(
      g.shift
    )}<span class="muted small" style="font-weight:400">${count} 診</span></div>`;

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
  const on = !!watch;

  const el = document.createElement('div');
  el.className = 'clinic' + (on ? ' on' : '');

  const main = document.createElement('label');
  main.className = 'clinic-main';
  main.innerHTML = `
    <input type="checkbox" ${on ? 'checked' : ''} />
    <span class="clinic-name">${escapeHtml(row.ROM_RONAME)}</span>
    <span class="clinic-doc">${escapeHtml(row.EMP_EMPNAME || '')}</span>
    <span class="clinic-prog">${progressPill(row)}</span>`;
  el.appendChild(main);

  main.querySelector('input').addEventListener('change', (e) => {
    if (e.target.checked) {
      watchMap.set(key, {
        ...DEFAULT_WATCH,
        shift: row.SHI_EASYNAME,
        section: row.SEC_SENAME,
        room: row.ROM_RONAME,
        doctor: row.EMP_EMPNAME
      });
    } else {
      watchMap.delete(key);
      if (settings.badgeKey === key) settings.badgeKey = null;
    }
    markDirty();
    render();
  });

  if (on) el.appendChild(detailPanel(key, watch));
  return el;
}

function progressPill(row) {
  const phase = phaseOf(row.CLC_MAXIMUM);
  const cls = phase === 'open' ? '' : phase === 'finished' ? ' grey' : ' grey';
  return `<span class="pill${cls}">${escapeHtml(progressText(row.CLC_MAXIMUM))}</span>`;
}

function detailPanel(key, watch) {
  const d = document.createElement('div');
  d.className = 'detail';
  d.innerHTML = `
    <label title="填了號碼才能做「快輪到我」提醒；留空則只在進度異動時通知">
      我的號碼
      <input type="number" min="0" step="1" class="my-number" value="${
        watch.myNumber ?? ''
      }" placeholder="選填" />
    </label>
    <label>
      <input type="checkbox" class="notify-near" ${watch.notifyNear ? 'checked' : ''} />
      快輪到我時通知（剩
      <input type="number" min="1" max="50" step="1" class="near-threshold" style="width:58px"
        value="${watch.nearThreshold ?? 3}" /> 號）
    </label>
    <div class="sep"></div>
    <label>
      <input type="checkbox" class="notify-change" ${watch.notifyOnChange ? 'checked' : ''} />
      進度號碼一有異動就通知
    </label>
    <label>
      <input type="checkbox" class="notify-status" ${watch.notifyStatus ? 'checked' : ''} />
      開始看診 / 看診結束時通知
    </label>`;

  const upd = (patch) => {
    watchMap.set(key, { ...watchMap.get(key), ...patch });
    markDirty();
  };

  d.querySelector('.my-number').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    upd({ myNumber: v === '' ? null : Math.max(0, parseInt(v, 10) || 0) });
  });
  d.querySelector('.near-threshold').addEventListener('input', (e) => {
    upd({ nearThreshold: Math.max(1, parseInt(e.target.value, 10) || 3) });
  });
  d.querySelector('.notify-near').addEventListener('change', (e) =>
    upd({ notifyNear: e.target.checked })
  );
  d.querySelector('.notify-change').addEventListener('change', (e) =>
    upd({ notifyOnChange: e.target.checked })
  );
  d.querySelector('.notify-status').addEventListener('change', (e) =>
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
  box.innerHTML = '';

  for (const [key, w] of orphans) {
    const el = document.createElement('div');
    el.className = 'orphan';
    el.innerHTML = `
      <span class="grow">${escapeHtml(w.section)}／${escapeHtml(w.room)}
        <span class="muted small">（${escapeHtml(w.shift)}${
          w.myNumber != null ? '・我的號碼 ' + w.myNumber : ''
        }）</span></span>`;
    const btn = document.createElement('button');
    btn.textContent = '移除';
    btn.addEventListener('click', () => {
      watchMap.delete(key);
      if (settings.badgeKey === key) settings.badgeKey = null;
      markDirty();
      render();
    });
    el.appendChild(btn);
    box.appendChild(el);
  }
}

function renderBadgeSelect() {
  const sel = $('#badge-key');
  sel.innerHTML = '';
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}
