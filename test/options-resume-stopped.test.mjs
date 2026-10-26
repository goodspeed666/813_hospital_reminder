// Load the options module with a small DOM/chrome harness and verify stopped watches can resume.
import vm from 'node:vm';
import * as common from '../common.js';

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
    this.controls = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.className = '';
    this.textContent = '';
    this._innerHTML = '';
  }
  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') {
      this.children = [];
      this.controls.clear();
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(selector) {
    if (this.controls.has(selector)) return this.controls.get(selector);
    for (const child of this.children) {
      if (child?.querySelector) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const matches = className
      ? new RegExp(`class="[^"]*\\b${className}\\b`).test(this._innerHTML)
      : selector === 'input' && /<input\b/.test(this._innerHTML);
    if (!matches) return null;
    const control = new Element();
    const tag = className
      ? this._innerHTML.match(new RegExp(`<input\\b[^>]*class="[^"]*\\b${className}\\b[^>]*>`))?.[0]
      : this._innerHTML.match(/<input\b[^>]*>/)?.[0];
    control.checked = !!tag && /\bchecked\b/.test(tag);
    const value = tag?.match(/\bvalue="([^"]*)"/);
    if (value) control.value = value[1];
    this.controls.set(selector, control);
    return control;
  }
  setAttribute() {}
}

const elements = new Map();
const document = {
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  },
  createElement() { return new Element(); }
};

const today = common.todayInTaipei();
const room = { shift: '下午', section: '家醫科', room: '家醫一診', doctor: '陳醫師' };
const row = {
  SCD_VISITDT: today,
  SHI_EASYNAME: room.shift,
  SEC_SENAME: room.section,
  ROM_RONAME: room.room,
  EMP_EMPNAME: room.doctor,
  CLC_MAXIMUM: '51'
};
const stored = {
  settings: { ...common.DEFAULT_SETTINGS },
  watches: [{ ...room, enabled: false, myNumber: 50, notifyNear: false, notifyOnChange: true, notifyStatus: false, nearThreshold: 7 }],
  states: {},
  snapshot: { fetchedAt: Date.now(), date: today, rows: [row] }
};
const messages = [];
let clinicRows = [row];
const optionsControl = { setRows(value) { clinicRows = value; } };
const chrome = {
  storage: { local: {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in stored).map((key) => [key, JSON.parse(JSON.stringify(stored[key]))]));
    },
    async set(value) { Object.assign(stored, JSON.parse(JSON.stringify(value))); }
  } },
  runtime: { async sendMessage(message) { messages.push(message); return { ok: true }; }, openOptionsPage() {} }
};
const window = { addEventListener() {} };
const fetch = async () => ({ ok: true, text: async () => JSON.stringify(clinicRows) });
globalThis.chrome = chrome;
globalThis.fetch = fetch;

const fs = await import('node:fs/promises');
let source = await fs.readFile(new URL('../options.js', import.meta.url), 'utf8');
source = source.replace(
  /^import\s*\{([\s\S]*?)\}\s*from\s*'\.\/common\.js';/m,
  (_, names) => `const {${names}} = globalThis.__common;`
);
source = source.replace(/^init\(\);/m, 'globalThis.__optionsStarted = init();');
source += '\nglobalThis.__optionsTest = { render, getWatchMap: () => watchMap, setRows: (value) => { rows = value; globalThis.__optionsControl.setRows(value); } };\n';
const context = vm.createContext({ __common: common, __optionsControl: optionsControl, chrome, document, window, fetch, console });
vm.runInContext(source, context, { filename: 'options.js' });
await context.__optionsStarted;

console.log('\n擴充功能設定頁：重新啟用已停止監看');
const clinic = document.querySelector('#clinic-list').children.flatMap((group) => group.children).find((child) => child.className.includes('clinic'));
const checkbox = clinic.querySelector('input');
check('已停止監看的診間以未勾選狀態顯示', checkbox.checked === false, String(checkbox.checked));
const details = clinic.children.find((child) => child.className === 'detail');
check('已停止狀態與原號碼設定仍可查看', !!details && details.innerHTML.includes('已過號，已停止監看') && !!clinic.querySelector('.my-number'));

checkbox.checked = true;
for (const listener of checkbox.listeners.change || []) listener({ target: checkbox });
const resumedClinic = document.querySelector('#clinic-list').children.flatMap((group) => group.children).find((child) => child.className.includes('clinic'));
const numberInput = resumedClinic.querySelector('.my-number');
numberInput.value = '55';
for (const listener of numberInput.listeners.input || []) listener({ target: numberInput });
await document.querySelector('#btn-save').listeners.click[0]();
const saved = stored.watches[0];
check('勾選並儲存新號碼會重新啟用', saved.enabled === true && saved.myNumber === 55, JSON.stringify(saved));
check('重新啟用保留原通知設定', saved.notifyNear === false && saved.notifyOnChange === true && saved.notifyStatus === false && saved.nearThreshold === 7, JSON.stringify(saved));

console.log('\n擴充功能設定頁：今日班表外的已停止監看');
const key = [...context.__optionsTest.getWatchMap().keys()][0];
context.__optionsTest.getWatchMap().get(key).enabled = false;
context.__optionsTest.setRows([]);
context.__optionsTest.render();
const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const orphanTree = descendants(document.querySelector('#orphan-list'));
const orphan = orphanTree.find((node) => node.className === 'orphan');
const orphanDetail = orphanTree.find((node) => node.className === 'detail');
const resume = orphanTree.find((node) => node.className === 'orphan-resume');
check('班表外項目顯示已停止狀態與原號碼', orphan?.innerHTML.includes('已停止監看') && orphan.innerHTML.includes('我的號碼 55'), orphan?.innerHTML);
check('班表外已停止項目仍提供號碼細項與重新啟用按鈕', !!orphanDetail && !!orphanDetail.querySelector('.my-number') && !!resume);
for (const listener of resume?.listeners.click || []) listener();
check('點選重新啟用保留班表外診間與提醒設定', context.__optionsTest.getWatchMap().get(key)?.enabled === true && context.__optionsTest.getWatchMap().get(key)?.notifyNear === false, JSON.stringify(context.__optionsTest.getWatchMap().get(key)));
context.__optionsTest.getWatchMap().get(key).enabled = false;
context.__optionsTest.render();
const stoppedOrphanDetail = descendants(document.querySelector('#orphan-list')).find((node) => node.className === 'detail');
const orphanNumber = stoppedOrphanDetail?.querySelector('.my-number');
if (orphanNumber) {
  orphanNumber.value = '60';
  for (const listener of orphanNumber.listeners.input || []) listener({ target: orphanNumber });
  await document.querySelector('#btn-save').listeners.click[0]();
}
check('班表外項目更改號碼後仍能儲存並啟用', stored.watches[0].enabled === true && stored.watches[0].myNumber === 60, JSON.stringify(stored.watches[0]));

console.log(failed === 0 ? '\n全部通過 ✅' : `\n${failed} 項失敗 ❌`);
process.exit(failed === 0 ? 0 : 1);
