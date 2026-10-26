// Exercise the real PWA app module in a small DOM harness without a browser dependency.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as logic from '../public/logic.js';

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓ ' + name);
  else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.classList = {
      values: new Set(),
      add: (...values) => values.forEach((value) => this.classList.values.add(value)),
      remove: (...values) => values.forEach((value) => this.classList.values.delete(value)),
      contains: (value) => this.classList.values.has(value)
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
  focus() {}
}

const elements = new Map();
const documentListeners = {};
const document = {
  visibilityState: 'hidden',
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  },
  createElement() { return new Element(); },
  addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); }
};

const today = logic.todayInTaipei();
const watch = {
  shift: '下午', section: '家醫科', room: '家醫一診', doctor: '陳醫師',
  enabled: true, notifyNear: true, notifyOnChange: false, notifyStatus: true,
  myNumber: 50, nearThreshold: 3
};
const initialState = {
  day: today,
  watches: [watch],
  states: {},
  prefs: { notify: false, push: true, wakeLock: true, sound: false },
  snapshot: null
};
const stored = new Map([['813pwa.v1', JSON.stringify(initialState)]]);
const localStorage = {
  getItem(key) { return stored.get(key) ?? null; },
  setItem(key, value) { stored.set(key, value); }
};

const syncBodies = [];
let progressCalls = 0;
let intervalCallback;
let lockRequests = 0;
let lockReleases = 0;
let rejectRegistration = false;
let responseProgress = '49';
let responseStale = false;
const responseControl = {
  setResponse(progress, stale = false) {
    responseProgress = progress;
    responseStale = stale;
  }
};
const subscription = { endpoint: 'https://push.example/sub', keys: { p256dh: 'p', auth: 'a' } };
const registration = { pushManager: { getSubscription: async () => subscription } };
const navigator = {
  userAgent: 'Node test',
  standalone: false,
  serviceWorker: {
    register: async () => ({}),
    getRegistration: async () => {
      if (rejectRegistration) throw new Error('service worker unavailable');
      return registration;
    },
    ready: Promise.resolve(registration)
  },
  wakeLock: {
    request: async () => {
      lockRequests++;
      return { addEventListener() {}, async release() { lockReleases++; } };
    }
  }
};
const window = { navigator, matchMedia: () => ({ matches: false }), addEventListener() {} };

function row(progress) {
  return {
    SCD_VISITDT: today,
    SHI_EASYNAME: watch.shift,
    SEC_SENAME: watch.section,
    ROM_RONAME: watch.room,
    EMP_EMPNAME: watch.doctor,
    CLC_MAXIMUM: progress,
    CLC_VISITNO_NOW: progress
  };
}

async function fetchImpl(url, init = {}) {
  if (String(url).endsWith('/api/config')) return { json: async () => ({ pushEnabled: false }) };
  if (String(url).endsWith('/api/subscribe')) {
    syncBodies.push(JSON.parse(init.body));
    return { json: async () => ({ ok: true }) };
  }
  if (String(url).includes('/api/progress')) {
    progressCalls++;
    return {
      json: async () => ({ ok: true, fetchedAt: Date.now(), date: today, rows: [row(responseProgress)], stale: responseStale, error: responseStale ? '暫時無法更新' : null })
    };
  }
  throw new Error('Unexpected URL: ' + url);
}

let source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
source = source.replace(
  /^import\s*\{([\s\S]*?)\}\s*from\s*'\.\/logic\.js';/m,
  (_, names) => `const {${names}} = globalThis.__logic;`
);
source = source.replace(/\ninit\(\);\s*$/, '\nglobalThis.__appStarted = init();');
source += '\nglobalThis.__appTest = { tick, state: () => state, timer: () => timer, updateWakeLock, setResponse: (progress, stale = false) => globalThis.__responseControl.setResponse(progress, stale) };\n';

const context = vm.createContext({
  __logic: logic,
  __responseControl: responseControl,
  document,
  localStorage,
  navigator,
  window,
  location: { search: '?api=https://api.example' },
  URLSearchParams,
  fetch: fetchImpl,
  Notification: { permission: 'default' },
  setInterval(fn) { intervalCallback = fn; return 1; },
  clearInterval() {},
  setTimeout() { return 1; },
  clearTimeout() {},
  console
});
vm.runInContext(source, context, { filename: 'pwa/public/app.js' });
await context.__appStarted;

console.log('\nPWA app 停止監看整合');
check('初次尚未過號仍取得 wake lock', lockRequests === 1, String(lockRequests));
context.__appTest.setResponse('51', true);
await context.__appTest.tick(true);
check('API 回傳 stale 舊進度不會停用監看', context.__appTest.state().watches[0].enabled === true, JSON.stringify(context.__appTest.state().watches));
context.__appTest.setResponse('51');
await context.__appTest.tick();
const persisted = JSON.parse(stored.get('813pwa.v1'));
check('過號後前端持久化 enabled:false', persisted.watches[0].enabled === false, JSON.stringify(persisted.watches));
check('過號後同步停用 watch 到 Worker', syncBodies.some((body) => body.watches[0].enabled === false), JSON.stringify(syncBodies));
check('停止後釋放 wake lock', lockReleases === 1, String(lockReleases));
check('畫面狀態明確指出已停止監看', /已停止監看|停止監看/.test(elements.get('#status')?.textContent || ''), elements.get('#status')?.textContent);

const requestsBeforeAutomaticTicks = progressCalls;
await intervalCallback();
for (const listener of documentListeners.visibilitychange || []) listener();
await new Promise((resolve) => setTimeout(resolve, 0));
check('停止後 interval 與 visibility 自動更新略過網路', progressCalls === requestsBeforeAutomaticTicks, String(progressCalls));

// Re-enable with a known baseline and make notification setup fail after fetching.
const stopped = context.__appTest.state().watches[0];
stopped.enabled = true;
context.__appTest.state().states[logic.watchKey(stopped)] = { progress: '49', phase: 'open', missing: false, notifiedPassed: false };
context.__appTest.state().snapshot.error = null;
context.__appTest.state().prefs.notify = true;
context.__appTest.state().prefs.push = false;
localStorage.setItem('813pwa.v1', JSON.stringify(context.__appTest.state()));
context.__appTest.setResponse('51');
await context.__appTest.updateWakeLock();
rejectRegistration = true;
await context.__appTest.tick();
const persistedAfterNotificationFailure = JSON.parse(stored.get('813pwa.v1'));
check('通知初始化失敗仍先持久化 stopped watch', persistedAfterNotificationFailure.watches[0].enabled === false, JSON.stringify(persistedAfterNotificationFailure.watches));
check('通知初始化失敗仍先釋放 wake lock', lockReleases === 2, String(lockReleases));

console.log(failed === 0 ? '\n全部通過 ✅' : `\n${failed} 項失敗 ❌`);
process.exit(failed === 0 ? 0 : 1);
